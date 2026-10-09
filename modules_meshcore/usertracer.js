/**
 * usertracer.js — Tracer agent module v0.1.1 (branch feature/session-tracer)
 * =============================================================================
 * Coleta orientada a evento com store-and-forward. Ver DESIGN-session-tracer.md.
 *
 * NOME DO ARQUIVO É CONTRATO: meshcore.js:2067 roteia comandos do servidor via
 *   require(data.plugin).consoleaction(...)  →  require('usertracer')
 * Logo este módulo DEVE se chamar usertracer.js dentro de modules_meshcore/.
 * (Ver tests/contract/upstream-channel.test.js — pina esse contrato no source.)
 *
 * Fluxo:
 *   user-sessions ('locked'/'unlocked'/'changed') → journal (write-ahead, JSONL)
 *     → push {action:'plugin', cmd:'events', batch:[...]} → ack → remove do journal
 *
 * Canal (verificado no upstream):
 *   - envio:    mesh.SendCommand({action:'plugin', plugin:'usertracer', ...})
 *               → MeshCentral meshagent.js:1591 'case plugin' → serveraction
 *   - recebimento: MeshCentral → {action:'plugin', plugin:'usertracer', ...}
 *               → meshcore.js:2066 → consoleaction(data, rights, sessionid, this)
 *
 * Este módulo NÃO conhece banco nem UI. Só coleta, journalea e transporta.
 */
"use strict";

var fs = null;           try { fs = require('fs'); } catch (e) {}
var mesh = null;         try { mesh = require('MeshAgent'); } catch (e) {}
var userSession = null;  try { userSession = require('user-sessions'); } catch (e) {}

var SCHEMA = 1;
var JOURNAL_FILE = 'session-tracer.journal';
var JOURNAL_CAP_EVENTS = 10000;      // cap de segurança (ver design §3)
var DRAIN_INTERVAL_MS = 60000;       // tenta drenar pendências a cada 60s
var HEARTBEAT_MS = 6 * 3600 * 1000;  // heartbeat a cada 6h
var BATCH_MAX = 100;                 // eventos por mensagem

var obj = {
    _ObjectID: 'session-tracer',
    version: '0.1.1',
    schema: SCHEMA,
    enabled: true,       // controlável via config push do servidor
    idleSampleSec: 60    // reservado (idle sampling v0.2)
};

// Testabilidade: timers acessíveis (node:test precisa limpar p/ encerrar o processo)
// e _internals com hooks para injetar mocks de MeshAgent/user-sessions e espiar o journal.
var _timers = [];
obj._timers = _timers;
obj._internals = {
    journal: function () { return _journal; },
    pendingAck: function () { return _pendingAck; },
    header: function () { return _header; },
    append: _journalAppend,
    drain: _drain,
    emit: _emit,
    onChanged: _onChanged,
    lastUsers: function () { return _lastUsers; },
    setMesh: function (m) { mesh = m; },
    setSession: function (s) { userSession = s; },
    setCap: function (n) { JOURNAL_CAP_EVENTS = n; },
    save: _saveJournal
};

// -----------------------------------------------------------------------
// Journal (write-ahead JSONL)
// -----------------------------------------------------------------------
var _journal = [];            // [{id, type, ts, sid, user, seq, bootId}]
var _header = null;           // {v, schema, nextSeq, bootId}
var _draining = false;
var _pendingAck = [];         // ids enviados, aguardando ack (reenviados em reconnect)

function _bootId() {
    // id do boot: random + timestamp de carga do módulo. NÃO é persistido —
    // cada boot gera um novo; a ordenação canônica é (bootId, seq).
    return Math.floor((1 + Math.random()) * 0xFFFF).toString(16).toUpperCase() +
        '-' + Date.now().toString(36).toUpperCase();
}

function _loadJournal() {
    _header = { v: 1, schema: SCHEMA, nextSeq: 1, bootId: _bootId() };
    if (!fs) return;
    var raw = null;
    try { raw = fs.readFileSync(JOURNAL_FILE, 'utf8'); } catch (e) { raw = null; }
    if (!raw) return;
    var lines = raw.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var doc = null;
        try { doc = JSON.parse(line); } catch (e) { continue; } // linha parcial/corrompida → descarta
        if (doc && doc.h) { // cabeçalho
            if (doc.schema === SCHEMA && typeof doc.nextSeq === 'number') {
                _header.nextSeq = doc.nextSeq;
                _header.bootId = _bootId(); // novo boot: novo bootId, seq continua
            }
            continue;
        }
        if (doc && doc.id && doc.type) _journal.push(doc);
    }
}

function _saveJournal() {
    if (!fs) return;
    var out = [JSON.stringify({ h: 1, schema: SCHEMA, nextSeq: _header.nextSeq })];
    for (var i = 0; i < _journal.length; i++) out.push(JSON.stringify(_journal[i]));
    try {
        fs.writeFileSync(JOURNAL_FILE + '.tmp', out.join('\n') + '\n', 'utf8');
        try { fs.unlinkSync(JOURNAL_FILE); } catch (e) {}
        try { fs.renameSync(JOURNAL_FILE + '.tmp', JOURNAL_FILE); } catch (e2) {
            fs.writeFileSync(JOURNAL_FILE, out.join('\n') + '\n', 'utf8'); // fallback direto
        }
    } catch (e3) {}
}

function _journalAppend(type, userStr, sid, ts) {
    var evt = {
        id: _header.bootId + '-' + _header.nextSeq,
        schema: SCHEMA,
        type: type,
        ts: ts || Date.now(),
        sid: sid || null,
        user: userStr || null,
        seq: _header.nextSeq,
        bootId: _header.bootId
    };
    _header.nextSeq++;
    _journal.push(evt);

    // cap de segurança: descarta os mais antigos e marca a lacuna.
    // dropped conta o espaço do próprio marker (len - cap + 1) → len final <= cap.
    if (_journal.length > JOURNAL_CAP_EVENTS) {
        var dropped = _journal.length - JOURNAL_CAP_EVENTS + 1;
        _journal.splice(0, dropped);
        var mi = -1;
        for (var k = 0; k < _journal.length; k++) {
            if (_journal[k].type === 'journal.truncated') { mi = k; break; }
        }
        if (mi >= 0) {
            _journal[mi].dropped += dropped;         // marker único, acumula
        } else {
            _journal.push({
                id: _header.bootId + '-' + _header.nextSeq++,
                schema: SCHEMA, type: 'journal.truncated',
                ts: Date.now(), dropped: dropped, seq: _header.nextSeq, bootId: _header.bootId
            });
        }
    }
    _saveJournal();
    return evt;
}

// -----------------------------------------------------------------------
// Transporte
// -----------------------------------------------------------------------
function _sendCmd(cmd) {
    try {
        if (!mesh || typeof mesh.SendCommand !== 'function') return false;
        mesh.SendCommand(cmd);
        return true;
    } catch (e) { return false; }
}

function _drain() {
    if (_draining || !obj.enabled) return;
    if (_journal.length === 0 && _pendingAck.length === 0) return;
    _draining = true;
    try {
        // reenvia primeiro o que ficou sem ack (at-least-once; servidor dedup por id)
        var batch = _pendingAck.slice(0, BATCH_MAX);
        var need = BATCH_MAX - batch.length;
        if (need > 0 && _journal.length > 0) batch = batch.concat(_journal.slice(0, need));
        if (batch.length === 0) { _draining = false; return; }
        var ok = _sendCmd({
            action: 'plugin', plugin: 'usertracer', from: 'agent',
            cmd: 'events', ver: obj.version, batch: batch
        });
        if (ok) {
            // move os não-pendentes para pendingAck (só sai do journal após ack)
            var ids = {};
            for (var i = 0; i < batch.length; i++) ids[batch[i].id] = true;
            var stillPending = {};
            for (var p = 0; p < _pendingAck.length; p++) stillPending[_pendingAck[p].id] = true;
            var newJournal = [];
            for (var j = 0; j < _journal.length; j++) {
                if (ids[_journal[j].id] && !stillPending[_journal[j].id]) { _pendingAck.push(_journal[j]); }
                else newJournal.push(_journal[j]);
            }
            _journal = newJournal;
            _saveJournal();
        }
    } catch (e) { /* conexão caiu — tenta de novo no próximo ciclo */ }
    _draining = false;
}

// -----------------------------------------------------------------------
// Detecção de eventos (fonte: módulo user-sessions nativo do agente)
// -----------------------------------------------------------------------
function _formatUser(u) {
    try {
        if (!u) return null;
        if (typeof u === 'string') return u;
        if (u.Domain && (u.Name || u.Username)) return u.Domain + '\\' + (u.Name || u.Username);
        if (u.name) return u.name;
        return null;
    } catch (e) { return null; }
}

function _emit(type, user, sid) {
    if (!obj.enabled) return;
    _journalAppend(type, _formatUser(user), sid, Date.now());
    _drain(); // tenta live imediato; se offline, fica no journal
}

var _lastUsers = null; // diff local p/ logon/logoff (instantâneo, ts real)

function _onChanged() {
    if (!obj.enabled || !userSession || typeof userSession.enumerateUsers !== 'function') return;
    try {
        userSession.enumerateUsers().then(function (list) {
            var current = [];
            (list || []).forEach(function (s) {
                var u = _formatUser(s);
                if (u) current.push({ key: (s.SessionId != null ? s.SessionId : '') + '|' + u, u: u, sid: s.SessionId || null });
            });
            var curKeys = {};
            current.forEach(function (c) { curKeys[c.key] = c; });
            if (_lastUsers) {
                var prevKeys = {};
                _lastUsers.forEach(function (p) { prevKeys[p.key] = p; });
                current.forEach(function (c) { if (!prevKeys[c.key]) _emit('session.logon', c.u, c.sid); });
                _lastUsers.forEach(function (p) { if (!curKeys[p.key]) _emit('session.logoff', p.u, p.sid); });
            }
            _lastUsers = current;
        });
    } catch (e) {}
}

try {
    if (userSession && typeof userSession.on === 'function') {
        userSession.on('locked', function (u) { _emit('session.lock', u, null); });
        userSession.on('unlocked', function (u) { _emit('session.unlock', u, null); });
        userSession.on('changed', function () { _onChanged(); });
    }
    _onChanged(); // estado inicial
} catch (e) {}

// -----------------------------------------------------------------------
// consoleaction — comandos do servidor via {action:'plugin', plugin:'usertracer'}
// (meshcore.js:2066 → require(plugin).consoleaction(data, rights, sessionid, this))
// -----------------------------------------------------------------------
obj.consoleaction = function (data, rights, sessionid, conn) {
    try {
        if (!data || !data.cmd) return;
        switch (data.cmd) {
            case 'ack': {
                // remove do pendingAck (e do journal) apenas o que o servidor confirmou
                var acked = {};
                (data.ids || []).forEach(function (id) { acked[id] = true; });
                _pendingAck = _pendingAck.filter(function (e) { return !acked[e.id]; });
                _saveJournal();
                _drain();
                break;
            }
            case 'config': {
                if (typeof data.enabled === 'boolean') obj.enabled = data.enabled;
                if (typeof data.idleSampleSec === 'number') obj.idleSampleSec = data.idleSampleSec;
                break;
            }
            case 'query-state': {
                // resposta de estado atual on-demand; correlação via reqId
                var reply = {
                    action: 'plugin', plugin: 'usertracer', from: 'agent',
                    cmd: 'state', reqId: data.reqId, moduleVer: obj.version,
                    journalPending: _journal.length
                };
                try {
                    if (userSession && typeof userSession.enumerateUsers === 'function') {
                        userSession.enumerateUsers().then(function (list) {
                            reply.sessions = (list || []).map(function (s) {
                                return { sid: s.SessionId != null ? s.SessionId : null, user: _formatUser(s) };
                            });
                            reply.locked = [];
                            try {
                                var l = userSession.lusers || null; // nem sempre exposto
                                if (Array.isArray(l)) reply.locked = l.map(_formatUser);
                            } catch (e2) {}
                            _sendCmd(reply);
                        });
                    } else {
                        reply.sessions = [];
                        _sendCmd(reply);
                    }
                } catch (e3) { reply.sessions = []; _sendCmd(reply); }
                break;
            }
        }
    } catch (e) {}
};

// -----------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------
_loadJournal();

// hello: anuncia presença/capacidades; servidor responde com config push
_sendCmd({ action: 'plugin', plugin: 'usertracer', from: 'agent', cmd: 'hello', ver: obj.version, schema: SCHEMA });
_drain(); // drena pendências de boots anteriores

_timers.push(setInterval(_drain, DRAIN_INTERVAL_MS));
_timers.push(setInterval(function () {
    if (!obj.enabled) return;
    _sendCmd({
        action: 'plugin', plugin: 'usertracer', from: 'agent', cmd: 'events',
        ver: obj.version, batch: [{
            id: _header.bootId + '-hb-' + Date.now(), schema: SCHEMA,
            type: 'device.heartbeat', ts: Date.now(), seq: 0, bootId: _header.bootId,
            journalPending: _journal.length
        }]
    });
}, HEARTBEAT_MS));
_timers.forEach(function (t) { try { t.unref(); } catch (e) {} });

module.exports = obj;
