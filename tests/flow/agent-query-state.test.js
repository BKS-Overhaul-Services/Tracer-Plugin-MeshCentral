'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMock, buildUser } = require('../_helpers/mock-meshcentral');

const factory = require('../../usertracer.js').usertracer;

// =============================================================================
// Flow: query-state on-demand (browser → servidor → agente → servidor → browser)
//
// Pipeline (design §6.5b):
//   1. browser: {pluginaction:'queryState', nodeid} via serveraction (sessão WS)
//   2. ACL: _filterAccessibleNodeIds (admin full bypass ou MESHRIGHT_DEVICEDETAILS)
//   3. servidor acha o agente em wsagents[nid] e envia {cmd:'query-state', reqId}
//      — JSON string (protocolo servidor→agente)
//   4. agente responde {from:'agent', cmd:'state', reqId} → roteado de volta ao
//      sid do browser via _pendingAgentQueries
//   5. agente offline/timeout → liveState {offline:true} imediato, ninguém pendura
// =============================================================================

function makeSetup(opts) {
    opts = opts || {};
    const user = opts.user || buildUser({ name: 'admin1', siteadmin: 0xFFFFFFFF });
    const agentConn = {
        nodeid: 'node//domain/n1',
        name: 'BR-25001',
        sent: [],
        send: function (d) { agentConn.sent.push(typeof d === 'string' ? JSON.parse(d) : d); }
    };
    const wssessions2 = { 'sess-1': { user: user } };
    const { parent, captured } = buildMock({
        wsagents: { 'node//domain/n1': agentConn },
        wssessions2: wssessions2,
        getNodeWithRights: opts.getNodeWithRights
    });
    const obj = factory(parent);
    obj.db = { getEvents: function (q, o, cb) { cb([]); }, getEventsByNode: function (n, o, cb) { cb([]); }, addEvent: function () {} };
    return { obj, agentConn, captured, user };
}

function browserQuery(obj) {
    obj.serveraction(
        { action: 'plugin', plugin: 'usertracer', pluginaction: 'queryState', nodeid: 'node//domain/n1' },
        { ws: { sessionId: 'sess-1' }, user: null }, null
    );
}

test('queryState: browser pergunta → agente recebe query-state → resposta volta ao browser', () => {
    const { obj, agentConn, captured } = makeSetup();

    browserQuery(obj);

    // 1. agente recebeu a query com reqId, como JSON string
    assert.equal(agentConn.sent.length, 1);
    const q = agentConn.sent[0];
    assert.equal(typeof q, 'object'); // mock parseia
    assert.equal(q.cmd, 'query-state');
    assert.equal(q.plugin, 'usertracer');
    assert.ok(q.reqId);

    // 2. agente responde (simula consoleaction → SendCommand → case 'plugin')
    obj._agentMessage({
        from: 'agent', cmd: 'state', reqId: q.reqId,
        sessions: [{ sid: 2, user: 'BKS\\maria.souza' }],
        locked: ['BKS\\maria.souza'], moduleVer: '0.1.1', journalPending: 3
    }, agentConn);

    // 3. browser recebeu liveState
    const toBrowser = captured.sent.filter(function (m) { return m.data.method === 'liveState'; });
    assert.equal(toBrowser.length, 1);
    const resp = toBrowser[0].data;
    assert.equal(resp.offline, false);
    assert.equal(resp.nodeid, 'node//domain/n1');
    assert.deepEqual(resp.sessions, [{ sid: 2, user: 'BKS\\maria.souza' }]);
    assert.deepEqual(resp.locked, ['BKS\\maria.souza']);
    assert.equal(resp.journalPending, 3);
});

test('queryState: agente offline responde offline imediatamente', () => {
    const { obj, captured } = makeSetup();
    // sem wsagents: agente não conectado
    obj.meshServer.webserver.wsagents = {};

    browserQuery(obj);

    const toBrowser = captured.sent.filter(function (m) { return m.data.method === 'liveState'; });
    assert.equal(toBrowser.length, 1);
    assert.equal(toBrowser[0].data.offline, true);
});

test('queryState: timeout do agente responde offline (ninguém fica pendurado)', (t, done) => {
    const { obj, captured } = makeSetup();
    obj._queryTimeoutMs = 40; // acelera o teste

    browserQuery(obj);

    setTimeout(function () {
        const toBrowser = captured.sent.filter(function (m) { return m.data.method === 'liveState'; });
        assert.equal(toBrowser.length, 1);
        assert.equal(toBrowser[0].data.offline, true);
        assert.equal(toBrowser[0].data.timeout, true);
        done();
    }, 120);
});

test('queryState: resposta tardia após timeout é descartada com segurança', (t, done) => {
    const { obj, agentConn, captured } = makeSetup();
    obj._queryTimeoutMs = 40;

    browserQuery(obj);
    const reqId = agentConn.sent[0].reqId;

    setTimeout(function () {
        const before = captured.sent.length;
        // resposta chega DEPOIS do timeout — não deve rotear nada ao browser
        obj._agentMessage({ from: 'agent', cmd: 'state', reqId: reqId, sessions: [] }, agentConn);
        const live = captured.sent.slice(before).filter(function (m) { return m.data.method === 'liveState'; });
        assert.equal(live.length, 0);
        done();
    }, 120);
});

test('queryState: sem ACL (usuário comum sem DEVICEDETAILS) → forbidden offline', () => {
    const { obj, agentConn, captured } = makeSetup({
        user: buildUser({ name: 'limited', siteadmin: 0 }),
        // nega: visible=false
        getNodeWithRights: function (domain, user, nid, cb) { cb(null, 0, false); }
    });

    browserQuery(obj);

    assert.equal(agentConn.sent.length, 0); // agente nem foi perturbado
    const toBrowser = captured.sent.filter(function (m) { return m.data.method === 'liveState'; });
    assert.equal(toBrowser.length, 1);
    assert.equal(toBrowser[0].data.offline, true);
    assert.equal(toBrowser[0].data.error, 'forbidden');
});

test('queryState: _agentSend envia JSON string (contrato do protocolo agente)', () => {
    // verifica no nível mais baixo: agentConn.send recebe STRING
    const rawSent = [];
    const user = buildUser({ name: 'admin1', siteadmin: 0xFFFFFFFF });
    const agentConn = {
        nodeid: 'node//domain/n1',
        sent: [],
        send: function (d) { rawSent.push(d); }
    };
    const { parent } = buildMock({ wsagents: { 'node//domain/n1': agentConn } });
    const obj = factory(parent);
    obj.db = { getEvents: function (q, o, cb) { cb([]); }, addEvent: function () {} };
    obj.serveraction(
        { action: 'plugin', plugin: 'usertracer', pluginaction: 'queryState', nodeid: 'node//domain/n1' },
        { ws: { sessionId: 'x' }, user: user }, null
    );
    // wssessions2 não tem 'x' → _send falha silenciosamente, mas o envio ao agente ocorreu
    assert.equal(rawSent.length, 1);
    assert.equal(typeof rawSent[0], 'string');
    const parsed = JSON.parse(rawSent[0]);
    assert.equal(parsed.cmd, 'query-state');
});
