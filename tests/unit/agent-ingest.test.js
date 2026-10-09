'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMock } = require('../_helpers/mock-meshcentral');

const factory = require('../../usertracer.js').usertracer;

// =============================================================================
// Unit: ingestão de eventos do agente no servidor (_agentMessage/_agentIngest)
//
// Canal upstream (verificado no source, MeshCentral master):
//   meshagent.js:1591  case 'plugin': →
//   meshagent.js:1594  pluginHandler.plugins[command.plugin].serveraction(command, obj, parent)
//   onde obj = conexão do agente (tem .nodeid, .send; NÃO tem .ws/.user).
//
// O serveraction ANTIGO descartava essas mensagens (check de sid antes do
// branch from:'agent'). O branch v4.0 deve vir antes.
//
// Contratos pinados:
//   - hello → config push de volta ao agente + registro _agentNodes
//   - events → valida → dedup (memória + banco) → PERSISTE antes do ack → ack com TODOS ids
//   - duplicado é ackado normalmente (retransmissão é esperada, não é erro)
//   - heartbeat → observabilidade em _agentNodes, sem gravar evento
//   - evento inválido (sem id/type/ts) → NÃO é ackado
//   - _agentSend SEMPRE envia JSON string (protocolo servidor→agente)
// =============================================================================

function makeAgentConn(nodeid, name) {
    const conn = {
        nodeid: nodeid,
        name: name || 'PC-1',
        sent: [],
        send: function (d) { conn.sent.push(typeof d === 'string' ? JSON.parse(d) : d); }
    };
    return conn;
}

function makeDb(stored, byEventId) {
    return {
        getEvents: function (query, opts, cb) {
            const id = query && query.eventId;
            cb(id && byEventId[id] ? [byEventId[id]] : []);
        },
        getEventsByNode: function (n, o, cb) { cb([]); },
        addEvent: function (evt) { stored.push(evt); }
    };
}

function makeObj(opts) {
    const agentConn = makeAgentConn('node//domain/n1', 'BR-25001');
    const { parent, captured } = buildMock(Object.assign({
        wsagents: { 'node//domain/n1': agentConn }
    }, opts));
    const obj = factory(parent);
    const stored = [];
    obj.db = makeDb(stored, (opts && opts.byEventId) || {});
    obj._seenEventIds = {}; // isolado por teste
    return { obj, agentConn, captured, stored };
}

// =============================================================================
// hello → config push
// =============================================================================

test('agent hello: responde config push e registra versão do módulo', () => {
    const { obj, agentConn } = makeObj();
    obj.serveraction({ action: 'plugin', plugin: 'usertracer', from: 'agent', cmd: 'hello', ver: '0.1.1', schema: 1 }, agentConn);
    assert.equal(agentConn.sent.length, 1);
    const cfg = agentConn.sent[0];
    assert.equal(cfg.action, 'plugin');
    assert.equal(cfg.from, 'server');
    assert.equal(cfg.cmd, 'config');
    assert.equal(cfg.enabled, true);
    assert.equal(obj._agentNodes['node//domain/n1'].moduleVer, '0.1.1');
});

// =============================================================================
// events → persist + ack
// =============================================================================

test('agent events: valida, persiste com src agent e acka todos os ids', () => {
    const { obj, agentConn, stored } = makeObj();
    obj.serveraction({
        action: 'plugin', plugin: 'usertracer', from: 'agent', cmd: 'events', ver: '0.1.1',
        batch: [
            { id: 'BOOT1-1', schema: 1, type: 'session.logon', ts: Date.now() - 60000, sid: 2, user: 'BKS\\maria.souza', seq: 1, bootId: 'BOOT1' },
            { id: 'BOOT1-2', schema: 1, type: 'session.lock', ts: Date.now() - 30000, sid: 2, user: 'BKS\\maria.souza', seq: 2, bootId: 'BOOT1' }
        ]
    }, agentConn);

    assert.equal(stored.length, 2);
    assert.equal(stored[0].eventType, 'userLogin');
    assert.equal(stored[1].eventType, 'userLock');
    assert.equal(stored[0].src, 'agent');
    assert.equal(stored[0].eventId, 'BOOT1-1');
    assert.equal(stored[0].displayUser, 'BKS\\maria.souza');
    assert.equal(stored[0].username, 'maria.souza');
    assert.equal(stored[0].domain, 'BKS');
    assert.equal(stored[0].nodeName, 'BR-25001');
    assert.ok(!isNaN(new Date(stored[0].detectedAt).getTime())); // ISO
    assert.equal(typeof stored[0].srvTs, 'number');

    assert.equal(agentConn.sent.length, 1);
    const ack = agentConn.sent[0];
    assert.equal(ack.cmd, 'ack');
    assert.deepEqual(ack.ids.sort(), ['BOOT1-1', 'BOOT1-2']);
});

test('agent events: duplicado (retransmissão) é ackado mas NÃO duplica no banco', () => {
    const batch = [
        { id: 'BOOT1-1', schema: 1, type: 'session.logon', ts: Date.now(), sid: 2, user: 'BKS\\maria', seq: 1, bootId: 'BOOT1' }
    ];
    const { obj, agentConn, stored } = makeObj();
    const cmd = { action: 'plugin', plugin: 'usertracer', from: 'agent', cmd: 'events', batch: batch };

    obj.serveraction(cmd, agentConn);
    assert.equal(stored.length, 1);

    // retransmissão idêntica (ack do 1º round se perdeu)
    obj.serveraction(JSON.parse(JSON.stringify(cmd)), agentConn);
    assert.equal(stored.length, 1);            // dedup em memória
    assert.equal(agentConn.sent.length, 2);
    assert.deepEqual(agentConn.sent[1].ids, ['BOOT1-1']); // ackado mesmo assim
});

test('agent events: duplicado pós-restart do servidor é dedupado via banco (eventId)', () => {
    const { obj, agentConn, stored } = makeObj({
        byEventId: { 'BOOT9-1': { eventId: 'BOOT9-1' } } // já existe no banco
    });
    obj.serveraction({
        action: 'plugin', plugin: 'usertracer', from: 'agent', cmd: 'events',
        batch: [{ id: 'BOOT9-1', schema: 1, type: 'session.logon', ts: Date.now(), sid: 1, user: 'u', seq: 1, bootId: 'BOOT9' }]
    }, agentConn);
    assert.equal(stored.length, 0);            // dedup via consulta ao banco
    assert.deepEqual(agentConn.sent[0].ids, ['BOOT9-1']); // e ackado
});

test('agent events: heartbeat atualiza observabilidade sem gravar evento', () => {
    const { obj, agentConn, stored } = makeObj();
    const ts = Date.now();
    obj.serveraction({
        action: 'plugin', plugin: 'usertracer', from: 'agent', cmd: 'events',
        batch: [{ id: 'BOOT1-hb-1', schema: 1, type: 'device.heartbeat', ts: ts, seq: 0, bootId: 'BOOT1', journalPending: 7 }]
    }, agentConn);
    assert.equal(stored.length, 0);
    assert.deepEqual(agentConn.sent[0].ids, ['BOOT1-hb-1']); // ackado
    assert.equal(obj._agentNodes['node//domain/n1'].lastHeartbeat, ts);
    assert.equal(obj._agentNodes['node//domain/n1'].journalPending, 7);
});

test('agent events: evento inválido (sem id) NÃO é ackado', () => {
    const { obj, agentConn, stored } = makeObj();
    obj.serveraction({
        action: 'plugin', plugin: 'usertracer', from: 'agent', cmd: 'events',
        batch: [{ type: 'session.lock', ts: Date.now() }, { id: 'OK-1', schema: 1, type: 'session.lock', ts: Date.now(), user: 'u', seq: 1, bootId: 'B' }]
    }, agentConn);
    assert.equal(stored.length, 1);
    assert.deepEqual(agentConn.sent[0].ids, ['OK-1']); // inválido ficou de fora
});

test('agent events: type de schema futuro desconhecido é ignorado mas ackado (forward-compat)', () => {
    const { obj, agentConn, stored } = makeObj();
    obj.serveraction({
        action: 'plugin', plugin: 'usertracer', from: 'agent', cmd: 'events',
        batch: [{ id: 'FUT-1', schema: 1, type: 'session.idle', ts: Date.now(), state: 'start', seq: 9, bootId: 'B' }]
    }, agentConn);
    assert.equal(stored.length, 0);
    assert.deepEqual(agentConn.sent[0].ids, ['FUT-1']);
});
