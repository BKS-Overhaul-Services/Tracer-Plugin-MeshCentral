'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// =============================================================================
// Unit: eventos do session-tracer com user-sessions MOCKADO
//
// O módulo real recebe require('user-sessions') no load do meshcore. Aqui
// injetamos um fake via _internals.setSession() e exercitamos os caminhos:
//   - onChanged: diff de snapshots → session.logon / session.logoff
//   - emit: session.lock/unlock direto (evento nativo do user-sessions)
//   - drain: push {action:'plugin', cmd:'events'} via mesh.SendCommand
//   - consoleaction query-state com enumerateUsers real (Promise)
//
// Mesma disciplina do NetAdapter: nada roda sem validação contra o contrato.
// =============================================================================

const MODULE = path.resolve(__dirname, '../../modules_meshcore/usertracer.js');
const JOURNAL_FILE = 'session-tracer.journal';

let _origCwd = null;

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ut-events-')); }

function loadModule(dir) {
    _origCwd = _origCwd || process.cwd();
    process.chdir(dir);
    delete require.cache[MODULE];
    return require(MODULE);
}

function unloadModule(mod) {
    mod.stopTimers && mod.stopTimers();
    (mod._timers || []).forEach(function (t) { try { clearInterval(t); } catch (e) {} });
    delete require.cache[MODULE];
    try { process.chdir(_origCwd); } catch (e) {}
}

function makeMeshCapture() {
    const mesh = { sent: [] };
    mesh.SendCommand = function (cmd) { mesh.sent.push(typeof cmd === 'string' ? JSON.parse(cmd) : cmd); };
    return mesh;
}

function fakeSession(list) {
    return {
        on: function () {},
        enumerateUsers: function () { return Promise.resolve(list); }
    };
}

// =============================================================================

test('eventos: onChanged detecta logon/logoff por diff de snapshot (com sid)', (t, done) => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        const mesh = makeMeshCapture();
        mod._internals.setMesh(mesh);

        // 1º snapshot: ana e bruno logados
        mod._internals.setSession(fakeSession([
            { SessionId: 1, Domain: 'BKS', Name: 'ana.souza' },
            { SessionId: 2, Domain: 'BKS', Name: 'bruno.lima' }
        ]));
        mod._internals.onChanged();
        assert.equal(mod._internals.journal().length, 0); // 1º snapshot = baseline, sem eventos

        // 2º snapshot: bruno saiu, carlos entrou
        mod._internals.setSession(fakeSession([
            { SessionId: 2, Domain: 'BKS', Name: 'bruno.lima' },
            { SessionId: 3, Domain: 'BKS', Name: 'carlos.pereira' }
        ]));
        mod._internals.onChanged();

        setTimeout(function () {
            // mesh mock aceita o envio → eventos saem do journal e ficam em pendingAck
            const evs = mod._internals.pendingAck();
            assert.equal(evs.length, 2);
            const types = evs.map(function (e) { return e.type; }).sort();
            assert.deepEqual(types, ['session.logoff', 'session.logon']);
            const logoff = evs.filter(function (e) { return e.type === 'session.logoff'; })[0];
            const logon = evs.filter(function (e) { return e.type === 'session.logon'; })[0];
            assert.equal(logoff.user, 'BKS\\ana.souza');
            assert.equal(logoff.sid, 1);
            assert.equal(logon.user, 'BKS\\carlos.pereira');
            assert.equal(logon.sid, 3);
            assert.ok(logon.ts > 0); // timestamp da ocorrência, não do scan
            done();
        }, 30);
    } finally { unloadModule(mod); }
});

test('eventos: emit lock/unlock grava no journal e drain empurra via mesh', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        // túnel caído: journala mas não envia
        mod._internals.setMesh({ SendCommand: function () { throw new Error('offline'); } });
        mod._internals.emit('session.lock', { Domain: 'BKS', Name: 'ana.souza' }, 1);
        assert.equal(mod._internals.journal().length, 1);

        // túnel volta: drain envia {action:'plugin', cmd:'events'}
        const mesh = makeMeshCapture();
        mod._internals.setMesh(mesh);
        mod._internals.drain();
        assert.equal(mesh.sent.length, 1);
        const msg = mesh.sent[0];
        assert.equal(msg.action, 'plugin');
        assert.equal(msg.plugin, 'usertracer');   // roteamento meshagent.js:1591
        assert.equal(msg.cmd, 'events');
        assert.equal(msg.batch[0].type, 'session.lock');
        assert.equal(msg.batch[0].user, 'BKS\\ana.souza');
        assert.equal(msg.batch[0].sid, 1);
    } finally { unloadModule(mod); }
});

test('consoleaction: query-state formata sessões do user-sessions (Domain\\Name + sid)', (t, done) => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        const mesh = makeMeshCapture();
        mod._internals.setMesh(mesh);
        mod._internals.setSession(fakeSession([
            { SessionId: 4, Domain: 'BKS', Name: 'djamilson' }
        ]));

        mod.consoleaction({ cmd: 'query-state', reqId: 'q9' }, null, null, null);

        setTimeout(function () {
            assert.equal(mesh.sent.length, 1);
            const reply = mesh.sent[0];
            assert.equal(reply.cmd, 'state');
            assert.equal(reply.reqId, 'q9');
            assert.deepEqual(reply.sessions, [{ sid: 4, user: 'BKS\\djamilson' }]);
            assert.ok(Array.isArray(reply.locked));
            done();
        }, 30);
    } finally { unloadModule(mod); }
});

test('consoleaction: ack limpa pendingAck; config altera enabled', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        const mesh = makeMeshCapture();
        mod._internals.setMesh(mesh);
        mod._internals.emit('session.logon', 'BKS\\x', 1);
        mod._internals.drain(); // vai p/ pendingAck
        assert.equal(mod._internals.pendingAck().length, 1);

        mod.consoleaction({ cmd: 'ack', ids: [mod._internals.pendingAck()[0].id] }, null, null, null);
        assert.equal(mod._internals.pendingAck().length, 0);

        mod.consoleaction({ cmd: 'config', enabled: false, idleSampleSec: 30 }, null, null, null);
        assert.equal(mod.enabled, false);
        assert.equal(mod.idleSampleSec, 30);
    } finally { unloadModule(mod); }
});

test('dispatcher: consoleaction cobre os 3 cmds e ignora desconhecidos sem crash', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        const mesh = makeMeshCapture();
        mod._internals.setMesh(mesh);
        // não pode lançar: qualquer erro no consoleaction derruba o handleServerCommand do core
        mod.consoleaction({ cmd: 'desconhecido' }, null, null, null);
        mod.consoleaction({}, null, null, null);
        mod.consoleaction(null, null, null, null);
        assert.equal(mesh.sent.length, 0); // nada enviado por cmds inválidos
        assert.equal(typeof mod.consoleaction, 'function'); // export obrigatório (meshcore.js:2067)
    } finally { unloadModule(mod); }
});
