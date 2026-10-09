'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// =============================================================================
// Unit: journal do módulo agente (modules_meshcore/usertracer.js)
//
// O módulo é carregado em Node puro: require('MeshAgent') e require('user-sessions')
// falham silenciosamente (try/catch) → mesh=null, userSession=null. Isso permite
// testar o journal, o drain e o consoleaction sem um agente real.
//
// O módulo usa cwd relativo ('session-tracer.journal') → cada teste roda em um
// tmpdir próprio via process.chdir (mesmo comportamento do meshcore no agente,
// onde cwd é a pasta do agente).
//
// Contratos pinados (design §3):
//   - write-ahead: evento no journal ANTES de qualquer envio
//   - ack = remoção: só sai do journal/pendingAck após cmd:'ack'
//   - cap: descarta os mais antigos + marcador journal.truncated
//   - crash-safety: última linha parcial é descartada; header preserva nextSeq
//   - bootId novo por carga; seq monotônico vindo do header
// =============================================================================

const MODULE = path.resolve(__dirname, '../../modules_meshcore/usertracer.js');
const JOURNAL_FILE = 'session-tracer.journal';

let _origCwd = null;

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ut-journal-'));
}

function loadModule(dir) {
    _origCwd = _origCwd || process.cwd();
    process.chdir(dir);
    delete require.cache[MODULE];
    return require(MODULE);
}

function unloadModule(mod) {
    (mod._timers || []).forEach(function (t) { try { clearInterval(t); } catch (e) {} });
    delete require.cache[MODULE];
    if (_origCwd) { try { process.chdir(_origCwd); } catch (e) {} }
}

function readJournalLines(dir) {
    const raw = fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8');
    return raw.split('\n').filter(function (l) { return l.trim(); });
}

// =============================================================================
// Boot e append
// =============================================================================

test('journal: boot novo cria header e append persiste JSONL write-ahead', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        assert.equal(mod._internals.journal().length, 0);
        assert.equal(mod._internals.header().nextSeq, 1);

        const evt = mod._internals.append('session.lock', 'BKS\\afarias', 3, 1728483600123);
        assert.equal(evt.seq, 1);
        assert.equal(evt.type, 'session.lock');
        assert.equal(evt.ts, 1728483600123); // timestamp real, não o do scan
        assert.ok(evt.id.endsWith('-1'));

        // persistiu em disco
        const lines = readJournalLines(dir);
        assert.equal(lines.length, 2); // header + 1 evento
        const saved = JSON.parse(lines[1]);
        assert.equal(saved.id, evt.id);
        assert.equal(saved.user, 'BKS\\afarias');
    } finally { unloadModule(mod); }
});

test('journal: seq é monotônico dentro do boot', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        const a = mod._internals.append('session.logon', 'u1', null);
        const b = mod._internals.append('session.lock', 'u1', null);
        const c = mod._internals.append('session.unlock', 'u1', null);
        assert.ok(a.seq < b.seq && b.seq < c.seq);
        assert.equal(a.bootId, b.bootId);
        assert.equal(b.bootId, c.bootId);
    } finally { unloadModule(mod); }
});

// =============================================================================
// Crash-safety
// =============================================================================

test('journal: linha parcial (queda de energia) é descartada, eventos válidos e nextSeq preservados', () => {
    const dir = tmpdir();
    // simula arquivo deixado por um crash: header + 2 eventos válidos + linha parcial
    const crashed = [
        '{"h":1,"schema":1,"nextSeq":42}',
        '{"id":"OLD1-41","schema":1,"type":"session.lock","ts":1,"seq":40,"bootId":"OLD1"}',
        '{"id":"OLD1-42","schema":1,"type":"session.unlock","ts":2,"seq":41,"bootId":"OLD1"}',
        '{"id":"OLD1-4'   // ← linha cortada no meio do write
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, JOURNAL_FILE), crashed, 'utf8');

    const mod = loadModule(dir);
    try {
        const journal = mod._internals.journal();
        assert.equal(journal.length, 2);                       // parcial descartada
        assert.equal(journal[0].id, 'OLD1-41');
        assert.equal(journal[1].id, 'OLD1-42');
        assert.equal(mod._internals.header().nextSeq, 42);     // header preservado
        assert.notEqual(mod._internals.header().bootId, 'OLD1'); // novo boot
    } finally { unloadModule(mod); }
});

// =============================================================================
// Cap de segurança
// =============================================================================

test('journal: cap descarta os mais antigos e marca a lacuna (marker único, len <= cap)', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        mod._internals.setCap(3);
        for (let i = 0; i < 5; i++) mod._internals.append('session.logon', 'u' + i, null);
        const journal = mod._internals.journal();
        assert.ok(journal.length <= 3, 'cap respeitado');
        const markers = journal.filter(function (e) { return e.type === 'journal.truncated'; });
        assert.equal(markers.length, 1);            // marker único
        assert.equal(markers[0].dropped, 4);        // u0..u3 descartados (conta o espaço do marker)
        assert.equal(journal[journal.length - 1].user, 'u4'); // o mais recente sobra
    } finally { unloadModule(mod); }
});

// =============================================================================
// Drain + ack (at-least-once)
// =============================================================================

test('drain: sem MeshAgent conectado, evento fica no journal (nada perdido)', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        mod._internals.setMesh({ SendCommand: function () { throw new Error('tunnel down'); } });
        mod._internals.append('session.lock', 'u1', null);
        mod._internals.drain();
        assert.equal(mod._internals.journal().length, 1);  // intacto
        assert.equal(mod._internals.pendingAck().length, 0);
    } finally { unloadModule(mod); }
});

test('drain: envia batch, move para pendingAck; ack remove tudo', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        const sent = [];
        // 1) offline: journaleia sem conseguir enviar
        mod._internals.setMesh({ SendCommand: function () { throw new Error('offline'); } });
        const e1 = mod._internals.append('session.lock', 'u1', null);
        const e2 = mod._internals.append('session.unlock', 'u1', null);
        mod._internals.drain();
        assert.equal(mod._internals.journal().length, 2);

        // 2) reconecta: drain envia batch e move para pendingAck
        mod._internals.setMesh({ SendCommand: function (cmd) { sent.push(cmd); } });
        mod._internals.drain();
        assert.equal(sent.length, 1);
        const msg = sent[0];
        assert.equal(msg.action, 'plugin');
        assert.equal(msg.plugin, 'usertracer');   // roteamento meshagent.js:1591
        assert.equal(msg.from, 'agent');
        assert.equal(msg.cmd, 'events');
        assert.deepEqual(msg.batch.map(function (e) { return e.id; }), [e1.id, e2.id]);
        assert.equal(mod._internals.journal().length, 0);
        assert.equal(mod._internals.pendingAck().length, 2);
        // já removido do disco (write-ahead só mantém o não-transmitido)
        assert.equal(readJournalLines(dir).length, 1); // só header

        // 3) ack do servidor: pendência some
        mod.consoleaction({ cmd: 'ack', ids: [e1.id, e2.id] }, null, null, null);
        assert.equal(mod._internals.pendingAck().length, 0);
    } finally { unloadModule(mod); }
});

test('drain: ack perdido → reenvio contém os mesmos ids (servidor dedupa)', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        const sent = [];
        mod._internals.setMesh({ SendCommand: function (c) { sent.push(c); } });
        const e1 = mod._internals.append('session.logon', 'u1', null);
        mod._internals.drain();
        mod._internals.drain(); // "reenvio" antes do ack
        assert.equal(sent.length, 2);
        // ambos os envios carregam o MESMO evento (at-least-once)
        assert.equal(sent[0].batch[0].id, e1.id);
        assert.equal(sent[1].batch[0].id, e1.id);
    } finally { unloadModule(mod); }
});

// =============================================================================
// consoleaction — canal servidor→agente (meshcore.js:2066)
// =============================================================================

test('consoleaction: query-state responde com reqId mesmo sem user-sessions', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        const sent = [];
        mod._internals.setMesh({ SendCommand: function (c) { sent.push(c); } });
        mod.consoleaction({ cmd: 'query-state', reqId: 'q77' }, null, null, null);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].cmd, 'state');
        assert.equal(sent[0].reqId, 'q77');
        assert.deepEqual(sent[0].sessions, []);
        assert.equal(typeof sent[0].journalPending, 'number');
    } finally { unloadModule(mod); }
});

test('consoleaction: config altera enabled/idleSampleSec', () => {
    const dir = tmpdir();
    const mod = loadModule(dir);
    try {
        mod.consoleaction({ cmd: 'config', enabled: false, idleSampleSec: 120 }, null, null, null);
        assert.equal(mod.enabled, false);
        assert.equal(mod.idleSampleSec, 120);
        // emit com disabled não journalea
        const before = mod._internals.journal().length;
        mod._internals.emit('session.lock', 'u1', null);
        assert.equal(mod._internals.journal().length, before);
    } finally { unloadModule(mod); }
});
