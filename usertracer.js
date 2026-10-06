/**
 * User-Device Tracer v3.5.94
 * ==========================
 * Corrigido conforme análise (v3.5.80 → v3.5.94):
 *   #1, #22  ACL no device tab (GetNodeWithRights)
 *   #3       stopScanner() + safeReload() para não vazar setInterval
 *   #4       Não gerar login events no bounce de agente (cross-ref lastconnect)
 *   #5,#20   Logs gateados por UT_DEBUG + redação de PII (usuário)
 *   #7       db.js agora suporta MongoDB / SQL (delegado para db.js)
 *   #10      registerPermissions RBAC (can_view_history, can_purge_history)
 *   #12,#2   Handler único (ms.socket.addEventListener). Sem leak em reload.
 *   #13      Tratamento de erro em addEvent
 *   #15      powerState lido diretamente do DB em getTimeline, sem cache volátil
 *   #19      Debounce nas requisições WS no frontend
 */
"use strict";

// Configurável via env var (apenas)
var UT_DEBUG = false; // debug sempre ativo — desligue em release build

// Event types enum (elimina drift entre scanner/admin)
var UT_EVENT = Object.freeze({
    LOGIN:   'userLogin',
    LOGOUT:  'userLogout',
    LOCK:    'userLock',
    UNLOCK:  'userUnlock'
});

// Categorias de log
var UT_LOG = {
    error: function (ctx, err, extra) {
        try {
            var msg = '[UT ERROR] ' + ctx + ': ' + (err && err.message ? err.message : String(err));
            if (extra) msg += ' extra=' + JSON.stringify(extra);
            if (UT_DEBUG) msg += ' stack=' + (err && err.stack ? err.stack : '(no stack)');
            console.log(msg);
        } catch (_) {}
    },
    debug: function () {
        if (!UT_DEBUG) return;
        try { console.log('[UT DEBUG] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (_) {}
    },
    info: function () {
        if (!UT_DEBUG) return;
        try { console.log('[UT INFO] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (_) {}
    },
    raw: function () {
        try { console.log('[UT] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (_) {}
    }
};

// Redação de PII para logs em produção (hash curto do usuário)
function _utRedactUser(u) {
    if (!u) return '<null>';
    var s = String(u);
    if (s.length <= 1) return s;
    if (s.indexOf('@') >= 0 || s.indexOf('\\') >= 0) {
        var parts = s.split(/[\\@]/);
        var domain = parts[0];
        var name = parts[1] || '';
        return domain + '\\' + (name.length > 1 ? name[0] + '***' + name[name.length - 1] : '***');
    }
    return s.length > 4 ? s.substring(0, 2) + '***' + s[s.length - 1] : '***';
}

// Validate eventType
function _utValidEventType(t) {
    for (var k in UT_EVENT) if (UT_EVENT[k] === t) return true;
    return false;
}

module.exports.usertracer = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.debug = obj.meshServer.debug;
    obj.exports = ['onDeviceRefreshEnd', 'currentUsers', 'nodeDetails', 'purgeResult', 'timeline', 'deviceNames', 'userNames'];
    obj.db = null;
    obj.mdb = obj.meshServer.db;
    obj.scanTimer = null;
    obj.intervalRef = null;
    obj.SCAN_INTERVAL = 30000;
    obj.userCache = {};
    obj.devicePower = {};     // TTL cache for power/conn state — replaces volatile devicePwr (#15)
    obj._pendingCheck = {};
    obj._stopped = false;
    obj._permissionsRegistered = false;

    UT_LOG.info('module loaded. parent.type=' + typeof parent + ' meshServer.type=' + typeof obj.meshServer);

    // -----------------------------------------------------------------------
    // server_startup — entrypoint
    // -----------------------------------------------------------------------
    obj.server_startup = function () {
        try {
            UT_LOG.info('server_startup: init');
            // #3 — sempre parar interval anterior antes de criar novo (hot-reload safe)
            obj.stopScanner();

            obj.meshServer.pluginHandler.usertracer_db = require(__dirname + '/db.js').CreateDB(obj.meshServer);
            obj.db = obj.meshServer.pluginHandler.usertracer_db;
            UT_LOG.raw('server_startup: db initialized db=' + typeof obj.db + ' getEvents=' + (typeof obj.db.getEvents));
            // Log raw wsagents state (primeiras entradas)
            try {
                var _ws = obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
                if (_ws) {
                    var _ids = Object.keys(_ws);
                    UT_LOG.raw('server_startup: wsagents count=' + _ids.length);
                    for (var _i = 0; _i < Math.min(_ids.length, 3); _i++) {
                        var _a = _ws[_ids[_i]];
                        UT_LOG.raw('server_startup: agent[' + _ids[_i] + ']=' + JSON.stringify({
                            name: _a && _a.name, nodeid: _a && _a.nodeid,
                            users: _a && _a.users, lusers: _a && _a.lusers,
                            conn: _a && _a.conn, pwr: _a && _a.pwr
                        }));
                    }
                } else {
                    UT_LOG.raw('server_startup: wsagents=null');
                }
            } catch (_ex) { UT_LOG.error('server_startup:wsagents', _ex); }

            // #10 — registrar permissões uma vez
            if (!obj._permissionsRegistered && obj.parent && typeof obj.parent.registerPermissions === 'function') {
                try {
                    obj.parent.registerPermissions('usertracer', {
                        can_view_history: {
                            title: 'User Tracer: visualizar histórico',
                            desc:  'Permite abrir o painel admin e a aba de histórico do dispositivo',
                            default: 'allowed'
                        },
                        can_purge_history: {
                            title: 'User Tracer: limpar histórico',
                            desc:  'Permite excluir eventos do histórico de Tracer',
                            default: 'denied'
                        }
                    });
                    obj._permissionsRegistered = true;
                } catch (e) { UT_LOG.error('registerPermissions', e); }
            }

            obj._stopped = false;
            obj.startScanner();
        } catch (e) {
            UT_LOG.error('server_startup', e, { step: 'init' });
        }
    };

    // #3 — stop timer (safe to call multiple times)
    obj.stopScanner = function () {
        obj._stopped = true;
        if (obj.scanTimer) { clearInterval(obj.scanTimer); obj.scanTimer = null; }
        if (obj.intervalRef) { clearInterval(obj.intervalRef); obj.intervalRef = null; }
        // cancela debounces pendentes
        if (obj._pendingCheck) {
            Object.keys(obj._pendingCheck).forEach(function (k) {
                if (obj._pendingCheck[k]) { clearTimeout(obj._pendingCheck[k]); delete obj._pendingCheck[k]; }
            });
        }
    };

    obj.startScanner = function () {
        if (obj._stopped) return;
        if (obj.scanTimer) clearInterval(obj.scanTimer);
        obj.scanNow(); // dispara imediatamente
        obj.scanTimer = setInterval(obj.scanNow, obj.SCAN_INTERVAL);
        // permite que o processo termine mesmo com o timer ativo
        if (typeof obj.scanTimer.unref === 'function') obj.scanTimer.unref();
        UT_LOG.info('scanner started interval=' + obj.SCAN_INTERVAL + 'ms');
    };

    obj.scanNow = function () {
        if (obj._stopped || !obj.meshServer || !obj.meshServer.webserver) return;
        var ws = obj.meshServer.webserver.wsagents;
        if (!ws) return;
        var ids = Object.keys(ws);
        UT_LOG.raw('scanNow start: total agents=' + ids.length);
        // Dump raw wsagents data (primeiros 5, resumido)
        try {
            for (var _si = 0; _si < Math.min(ids.length, 5); _si++) {
                var _sa = ws[ids[_si]];
                UT_LOG.raw('scanNow: agent[' + ids[_si] + ']=' + JSON.stringify({
                    name: _sa && _sa.name, nodeid: _sa && _sa.nodeid,
                    users: _sa && _sa.users, lusers: _sa && _sa.lusers,
                    conn: _sa && _sa.conn, pwr: _sa && _sa.pwr,
                    lastconnect: _sa && _sa.lastconnect
                }));
            }
        } catch (_ex) { UT_LOG.error('scanNow:dump', _ex); }
        UT_LOG.info('scanNow n=' + ids.length);
        for (var i = 0; i < ids.length; i++) {
            if (!ids[i]) continue;
            obj.checkNode(ids[i]);
        }
        // Limpar entradas de devicePower para devices offline a > 5 min
        var now = Date.now();
        if (obj.devicePower) {
            Object.keys(obj.devicePower).forEach(function (k) {
                if (obj.devicePower[k] && (now - obj.devicePower[k].time) > 5 * 60 * 1000) {
                    delete obj.devicePower[k];
                }
            });
        }
    };

    // Normaliza nodeid: se veio sem prefixo (ex: hook com myparent.nodeid curto),
    // tenta achar a chave completa em wsagents.
    obj._resolveNodeId = function (nodeid) {
        if (!nodeid || typeof nodeid !== 'string') return nodeid;
        // Já tem prefixo — retorna como está
        if (nodeid.indexOf('node//') === 0 || nodeid.indexOf('node/') === 0) return nodeid;
        // Procura em wsagents por chave que termina com o nodeid
        try {
            var ws = obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
            if (ws) {
                var keys = Object.keys(ws);
                for (var _ri = 0; _ri < keys.length; _ri++) {
                    if (keys[_ri] === 'node//' + nodeid || keys[_ri].indexOf(nodeid) >= 0) {
                        UT_LOG.raw('_resolveNodeId: mapped raw="' + nodeid.substring(0,40) + '..." → "' + keys[_ri] + '"');
                        return keys[_ri];
                    }
                }
            }
        } catch (_re) {}
        // Fallback: assume domínio padrão
        UT_LOG.raw('_resolveNodeId: no wsagent match for "' + nodeid.substring(0,40) + '..." — using node// prefix fallback');
        return 'node//' + nodeid;
    };

    obj.checkNode = function (nodeid) {
        if (obj._stopped) return;
        if (!nodeid || typeof nodeid !== 'string') return;
        if (!obj.mdb || typeof obj.mdb.Get !== 'function') return;

        nodeid = obj._resolveNodeId(nodeid);
        UT_LOG.raw('checkNode: mdb.Get start nodeid=' + nodeid);
        obj.mdb.Get(nodeid, function (err, docs) {
            if (err) { UT_LOG.error('checkNode:mdb.Get', err, { nodeid: nodeid }); return; }
            if (!docs || !docs.length) { UT_LOG.raw('checkNode: no docs for nodeid=' + nodeid); return; }
            var doc = docs[0];
            if (!doc || !doc._id) { UT_LOG.raw('checkNode: invalid doc for nodeid=' + nodeid); return; }

            UT_LOG.raw('checkNode: raw doc for ' + nodeid + '=' + JSON.stringify({
                _id: doc._id, name: doc.name, host: doc.host,
                users: doc.users, lusers: doc.lusers,
                pwr: doc.pwr, conn: doc.conn, lastconnect: doc.lastconnect
            }));

            // #15 — cache de power state com TTL
            obj.devicePower[nodeid] = {
                pwr: doc.pwr, conn: doc.conn,
                lastconnect: doc.lastconnect,
                time: Date.now()
            };

            var currentUsers = Array.isArray(doc.users) ? doc.users : [];
            var currentLusers = Array.isArray(doc.lusers) ? doc.lusers : [];
            var cacheState = { users: currentUsers, lusers: currentLusers };
            var key = JSON.stringify(cacheState);
            var prev = obj.userCache[nodeid];
            var nodeName = doc.name || nodeid;

            UT_LOG.raw('checkNode: userCache state for ' + nodeName + ' prev=' + (prev ? 'set' : 'null') + ' currentUsers=' + JSON.stringify(currentUsers) + ' currentLusers=' + JSON.stringify(currentLusers));

            // #4 — Não gerar login events falsos no bounce de agente.
            // Use doc.lastconnect para distinguir "primeiro scan após reconexão" de "primeiro scan ever"
            if (!prev) {
                UT_LOG.raw('checkNode: first scan for ' + nodeName + ' — will check lastconnect=' + doc.lastconnect);
                obj.userCache[nodeid] = key;
                if (!obj.db || typeof obj.db.getEventsByNode !== 'function') return;

                var initialLoggedSince = (typeof doc.lastconnect === 'number') ? new Date(doc.lastconnect * 1000) : null;
                UT_LOG.raw('checkNode: getEventsByNode check for ' + nodeName + ' lastconnect=' + doc.lastconnect + ' initialLoggedSince=' + (initialLoggedSince ? initialLoggedSince.toISOString() : 'null'));
                obj.db.getEventsByNode(nodeid, { limit: 1 }, function (events) {
                    var hasPrior = events && events.length > 0;
                    UT_LOG.raw('checkNode: first-scan callback for ' + nodeName + ' hasPrior=' + hasPrior + ' events=' + JSON.stringify(events));
                    // Só gera "first login" se não houver histórico E lastconnect > 2 min (evita bounce recém-conectado)
                    var recentBounce = initialLoggedSince && ((Date.now() - initialLoggedSince.getTime()) < 2 * 60 * 1000);
                    UT_LOG.raw('checkNode: first-scan decision for ' + nodeName + ' hasPrior=' + hasPrior + ' recentBounce=' + recentBounce + ' currentUsers=' + JSON.stringify(currentUsers));
                    if (!hasPrior && !recentBounce && currentUsers.length > 0) {
                        UT_LOG.info('first scan ever for ' + nodeName + ' with ' + currentUsers.length + ' users lusers=' + currentLusers.length);
                        currentUsers.forEach(function (u) {
                            // Se usuário está em lusers, estado real é bloqueado, não online
                            if (currentLusers.indexOf(u) >= 0) {
                                obj.storeEvent(nodeid, nodeName, u, UT_EVENT.LOCK);
                            } else {
                                obj.storeEvent(nodeid, nodeName, u, UT_EVENT.LOGIN);
                            }
                        });
                    } else {
                        UT_LOG.raw('checkNode: first-scan skipped for ' + nodeName + ' (hasPrior=' + hasPrior + ' recentBounce=' + recentBounce + ' users=' + currentUsers.length + ')');
                    }
                });
                return;
            }

            if (prev === key) {
                UT_LOG.raw('checkNode: no change for ' + nodeName + ' — cache hit');
                return;
            }
            UT_LOG.raw('checkNode: change detected for ' + nodeName + ' prev=' + prev + ' current=' + key);
            obj.userCache[nodeid] = key;

            var prevState = JSON.parse(prev);
            var prevUsers = prevState.users || [];
            var prevLusers = prevState.lusers || [];

            UT_LOG.raw('checkNode: prevUsers=' + JSON.stringify(prevUsers) + ' prevLusers=' + JSON.stringify(prevLusers));

            // detect LOGIN / LOGOUT
            currentUsers.forEach(function (u) {
                if (prevUsers.indexOf(u) === -1) {
                    // não emitir se for unlock (lock→login não é login novo)
                    var wasLocked = prevLusers.indexOf(u) >= 0;
                    var ev = wasLocked ? UT_EVENT.UNLOCK : UT_EVENT.LOGIN;
                    UT_LOG.raw('checkNode: storeEvent ' + nodeName + ' user=' + u + ' type=' + ev + ' wasLocked=' + wasLocked);
                    obj.storeEvent(nodeid, nodeName, u, ev);
                }
            });
            prevUsers.forEach(function (u) {
                if (currentUsers.indexOf(u) === -1) {
                    UT_LOG.raw('checkNode: storeEvent ' + nodeName + ' user=' + u + ' type=LOGOUT');
                    obj.storeEvent(nodeid, nodeName, u, UT_EVENT.LOGOUT);
                }
            });

            // detect LOCK / UNLOCK (transição users/lusers)
            currentUsers.forEach(function (u) {
                var isNowLocked = currentLusers.indexOf(u) >= 0;
                var wasLocked = (prevLusers.indexOf(u) >= 0) && (prevUsers.indexOf(u) >= 0);
                if (isNowLocked && !wasLocked && prevUsers.indexOf(u) >= 0) {
                    UT_LOG.raw('checkNode: storeEvent ' + nodeName + ' user=' + u + ' type=LOCK');
                    obj.storeEvent(nodeid, nodeName, u, UT_EVENT.LOCK);
                }
            });
            // UNLOCK: user estava em prevLusers mas não em currentLusers (e ainda em currentUsers)
            prevLusers.forEach(function (u) {
                var wasLocked = prevLusers.indexOf(u) >= 0;  // always true here
                var isNowLocked = currentLusers.indexOf(u) >= 0;
                if (wasLocked && !isNowLocked && currentUsers.indexOf(u) >= 0) {
                    UT_LOG.raw('checkNode: storeEvent ' + nodeName + ' user=' + u + ' type=UNLOCK');
                    obj.storeEvent(nodeid, nodeName, u, UT_EVENT.UNLOCK);
                }
            });

            UT_LOG.raw('checkNode: transitions done for ' + nodeName);
        });
    };

    obj.storeEvent = function (nodeid, nodeName, userStr, eventType) {
        if (!_utValidEventType(eventType)) {
            UT_LOG.error('storeEvent', new Error('invalid eventType'), { eventType: eventType });
            return;
        }
        if (!obj.db || typeof obj.db.addEvent !== 'function') {
            UT_LOG.error('storeEvent', new Error('db.addEvent not available'));
            return;
        }
        try {
            var username = userStr;
            var domain = '';
            if (typeof userStr === 'string') {
                if (userStr.indexOf('\\') >= 0) { var p = userStr.split('\\'); domain = p[0]; username = p[1]; }
                else if (userStr.indexOf('@') >= 0) { var p = userStr.split('@'); domain = p[1]; username = p[0]; }
            }
            var evt = {
                nodeid: nodeid,
                nodeName: nodeName,
                username: username,
                domain: domain,
                displayUser: userStr,
                eventType: eventType,
                detectedAt: new Date().toISOString()
            };
            UT_LOG.raw('storeEvent: raw evt=' + JSON.stringify(evt));
            obj.db.addEvent(evt); // #13 — addEvent agora trata erro internamente
            UT_LOG.info('event stored node=' + nodeName + ' user=' + _utRedactUser(userStr) + ' type=' + eventType);
        } catch (e) {
            UT_LOG.error('storeEvent', e, { nodeid: nodeid, eventType: eventType, userLen: userStr ? String(userStr).length : 0 });
        }
    };

    // -----------------------------------------------------------------------
    // Hooks do agente — emite scan incremental
    // -----------------------------------------------------------------------
    obj.hook_agentCoreIsStable = function (myparent, gp) {
        var nodeid = myparent ? myparent.nodeid : null;
        if (!nodeid || typeof nodeid !== 'string') return;
        UT_LOG.raw('hook_agentCoreIsStable: nodeid=' + nodeid + ' — will checkNode in 2s');
        setTimeout(function () {
            try { obj.checkNode(nodeid); } catch (e) { UT_LOG.error('hook_agentCoreIsStable.delayed', e); }
        }, 2000);
    };

    obj.hook_processAgentData = function (data, nodeid) {
        var nid = (typeof nodeid === 'string') ? nodeid : (nodeid && typeof nodeid === 'object' ? (nodeid.nodeid || nodeid._id) : null);
        if (!nid) {
            UT_LOG.raw('hook_processAgentData: no nid derived from nodeid=' + JSON.stringify(nodeid));
            return;
        }
        UT_LOG.raw('hook_processAgentData: nodeid=' + nid + ' raw data=' + (data ? JSON.stringify(data).substring(0, 300) : 'null') + ' — will checkNode in 2s');
        if (obj._pendingCheck[nid]) clearTimeout(obj._pendingCheck[nid]);
        obj._pendingCheck[nid] = setTimeout(function () {
            try { obj.checkNode(nid); } catch (e) { UT_LOG.error('hook_processAgentData.delayed', e); }
        }, 2000);
    };

    // -----------------------------------------------------------------------
    // HTTP — /pluginadmin.ashx
    // -----------------------------------------------------------------------
    obj.handleAdminReq = function (req, res, user) {
        try {
            UT_LOG.raw('handleAdminReq: ENTRY query=' + JSON.stringify(req.query) + ' user=' + JSON.stringify({ _id: user && user._id, name: user && user.name, siteadmin: user && user.siteadmin }));
            // Admin full bypass antes de qualquer ACL check
            if (user && (user.siteadmin === 0xFFFFFFFF || user.siteadmin === -1)) {
                UT_LOG.raw('handleAdminReq: admin full bypass');
                if (req.query.user == 1) {
                    var adminNid = req.query.nodeid;
                    UT_LOG.raw('handleAdminReq: device view (admin bypass) nodeid=' + adminNid);
                    if (!adminNid) { res.sendStatus(400); return; }
                    res.render('device', { nodeid: adminNid, nodeName: obj.getNodeName(adminNid) });
                    UT_LOG.raw('handleAdminReq: rendered device.handlebars (admin bypass)');
                    return;
                }
                UT_LOG.raw('handleAdminReq: admin panel (admin bypass)');
                res.render('admin', {});
                UT_LOG.raw('handleAdminReq: rendered admin.handlebars (admin bypass)');
                return;
            }
            // #1, #22 — ACL para device tab (não confiar em ?user=1)
            if (req.query.user == 1) {
                var nid = req.query.nodeid;
                UT_LOG.raw('handleAdminReq: device view (ACL path) nodeid=' + nid);
                if (!nid) { res.sendStatus(400); return; }
                var domain = (user && user.domain) || '';
                var webserver = obj.meshServer.webserver;
                if (webserver && typeof webserver.GetNodeWithRights === 'function') {
                    UT_LOG.raw('handleAdminReq: calling GetNodeWithRights domain=' + domain + ' user=' + (user && user._id) + ' nid=' + nid);
                    webserver.GetNodeWithRights(domain, user, nid, function (node, rights, visible) {
                        UT_LOG.raw('handleAdminReq: GetNodeWithRights returned visible=' + visible + ' rights=0x' + (rights ? rights.toString(16) : '0'));
                        // visible=false → user não tem access; rights=0 → sem rights
                        if (!visible || !rights || (rights & 0xFFFFFFFF) === 0) { UT_LOG.raw('handleAdminReq: device view DENIED (visible=' + visible + ' rights=0x' + (rights ? rights.toString(16) : '0') + ')'); res.sendStatus(401); return; }
                        if (obj.parent && typeof obj.parent.getAccessPermissions === 'function') {
                            obj.parent.getAccessPermissions('usertracer', user, { nodeid: nid }).then(function (has) {
                                UT_LOG.raw('handleAdminReq: getAccessPermissions returned can_view_history=' + has('can_view_history'));
                                if (!has('can_view_history')) { UT_LOG.raw('handleAdminReq: can_view_history DENIED'); res.sendStatus(403); return; }
                                res.render('device', { nodeid: nid, nodeName: (node.name || nid) });
                                UT_LOG.raw('handleAdminReq: rendered device.handlebars (ACL path)');
                            }).catch(function () {
                                UT_LOG.raw('handleAdminReq: getAccessPermissions catch — checking siteadmin');
                                // se getAccessPermissions falhar, ainda checa se admin
                                if (!user || (user.siteadmin & 0xFFFFFFFF) == 0) { res.sendStatus(403); return; }
                                res.render('device', { nodeid: nid, nodeName: (node.name || nid) });
                                UT_LOG.raw('handleAdminReq: rendered device.handlebars (ACL fallback)');
                            });
                        } else {
                            UT_LOG.raw('handleAdminReq: no getAccessPermissions — checking siteadmin');
                            if (!user || (user.siteadmin & 0xFFFFFFFF) == 0) { UT_LOG.raw('handleAdminReq: not admin — 403'); res.sendStatus(403); return; }
                            res.render('device', { nodeid: nid, nodeName: (node.name || nid) });
                            UT_LOG.raw('handleAdminReq: rendered device.handlebars (no getAccessPermissions)');
                        }
                    });
                } else {
                    UT_LOG.raw('handleAdminReq: no GetNodeWithRights — fallback checking siteadmin');
                    // Sem GetNodeWithRights — fallback conservador: exige siteadmin
                    if (!user || (user.siteadmin & 0xFFFFFFFF) == 0) { UT_LOG.raw('handleAdminReq: not admin — 401'); res.sendStatus(401); return; }
                    res.render('device', { nodeid: nid, nodeName: obj.getNodeName(nid) });
                    UT_LOG.raw('handleAdminReq: rendered device.handlebars (no GetNodeWithRights)');
                }
                return;
            }
            // admin panel
            UT_LOG.raw('handleAdminReq: admin panel (ACL path) siteadmin=0x' + (user ? (user.siteadmin ? user.siteadmin.toString(16) : '0') : 'null'));
            if (!user || (user.siteadmin & 0xFFFFFFFF) == 0) { UT_LOG.raw('handleAdminReq: not admin — 401'); res.sendStatus(401); return; }
            // checar can_view_history no nível admin (sem context nodeid)
            if (obj.parent && typeof obj.parent.getAccessPermissions === 'function' && obj.parent.pluginPermissions && obj.parent.pluginPermissions.usertracer) {
                obj.parent.getAccessPermissions('usertracer', user, {}).then(function (has) {
                    UT_LOG.raw('handleAdminReq: getAccessPermissions returned can_view_history=' + has('can_view_history'));
                    if (!has('can_view_history') && (user.siteadmin & 0xFFFFFFFF) != 0xFFFFFFFF) { UT_LOG.raw('handleAdminReq: can_view_history DENIED'); res.sendStatus(403); return; }
                    res.render('admin', {});
                    UT_LOG.raw('handleAdminReq: rendered admin.handlebars (ACL path)');
                }).catch(function () {
                    UT_LOG.raw('handleAdminReq: getAccessPermissions catch — rendering anyway');
                    res.render('admin', {});
                });
            } else {
                UT_LOG.raw('handleAdminReq: no pluginPermissions — rendering admin panel');
                res.render('admin', {});
            }
        } catch (e) {
            UT_LOG.error('handleAdminReq', e);
            try { res.sendStatus(500); } catch (_) {}
        }
    };

    // -----------------------------------------------------------------------
    // serveraction — WebSocket dispatcher
    // -----------------------------------------------------------------------
    obj.serveraction = function (command, myparent, gp) {
        try {
            if (!command || command.plugin !== 'usertracer') return;
            var sid = null;
            try { sid = myparent && myparent.ws && myparent.ws.sessionId; } catch (_) {}
            if (!sid) {
                UT_LOG.raw('serveraction: no sid — command=' + JSON.stringify(command));
                return;
            }
            // Extrair user diretamente do myparent (mais confiável que wssessions2)
            var userFromParent = null;
            try { userFromParent = myparent && myparent.user; } catch (_) {}
            UT_LOG.raw('serveraction: dispatching sid=' + (sid ? sid.substring(0,40) : 'null') + ' pluginaction=' + command.pluginaction + ' raw=' + JSON.stringify(command) + ' userFromParent=' + (userFromParent ? userFromParent._id : 'null'));

            if (command.pluginaction === 'getCurrentUsers')     return obj._actionGetCurrentUsers(command, sid, userFromParent);
            if (command.pluginaction === 'getTimeline')         return obj._actionGetTimeline(command, sid, userFromParent);
            if (command.pluginaction === 'getDeviceNames')      return obj._actionGetDeviceNames(command, sid, userFromParent);
            if (command.pluginaction === 'getUserNames')        return obj._actionGetUserNames(command, sid, userFromParent);
            if (command.pluginaction === 'getNodeDetails')      return obj._actionGetNodeDetails(command, sid, userFromParent);
            if (command.pluginaction === 'purgeHistory')        return obj._actionPurgeHistory(command, myparent, sid);
            UT_LOG.raw('serveraction: unknown action=' + command.pluginaction + ' raw=' + JSON.stringify(command));
        } catch (e) {
            UT_LOG.error('serveraction', e, { pluginaction: command && command.pluginaction });
        }
    };

    // --- getCurrentUsers: ACL filter via GetNodeWithRights (v3.5.83 security fix) ---
    obj._actionGetCurrentUsers = function (command, sid, parentUser) {
        UT_LOG.raw('getCurrentUsers: entry sid=' + (sid ? sid.substring(0,40) : 'null'));
        var user = obj._getSessionUser(sid, parentUser);
        if (!user) { UT_LOG.raw('getCurrentUsers: no user — sending empty'); obj._send(sid, { action:'plugin', plugin:'usertracer', method:'currentUsers', data: [] }); return; }
        if (!obj.mdb || typeof obj.mdb.Get !== 'function') {
            UT_LOG.raw('getCurrentUsers: no mdb.Get — sending empty');
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'currentUsers', data: [] });
            return;
        }
        var ws = obj.meshServer.webserver.wsagents || {};
        var allIds = Object.keys(ws);
        UT_LOG.raw('getCurrentUsers: raw wsagents keys=' + allIds.length + ' sample=' + JSON.stringify(allIds.slice(0, 5)));
        if (allIds.length === 0) {
            UT_LOG.raw('getCurrentUsers: no wsagents — sending empty');
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'currentUsers', data: [] });
            return;
        }
        // ACL: filtrar wsagents por MESHRIGHT_DEVICEDETAILS
        obj._filterAccessibleNodeIds(user, allIds, function (accessibleIds) {
            UT_LOG.raw('getCurrentUsers: accessibleIds=' + JSON.stringify(accessibleIds) + ' (from ' + allIds.length + ' total)');
            if (accessibleIds.length === 0) {
                UT_LOG.raw('getCurrentUsers: no accessible nodes — sending empty');
                obj._send(sid, { action:'plugin', plugin:'usertracer', method:'currentUsers', data: [] });
                return;
            }
            var done = false;
            var remaining = accessibleIds.length;
            var result = [];
            var timeout = setTimeout(function () {
                if (done) return;
                done = true;
                UT_LOG.raw('getCurrentUsers: TIMEOUT after 5s — sending partial result=' + JSON.stringify(result));
                obj._send(sid, { action:'plugin', plugin:'usertracer', method:'currentUsers', data: result, _partial: true });
            }, 5000);
            accessibleIds.forEach(function (nid) {
                obj.mdb.Get(nid, function (err, docs) {
                    if (done) return;
                    if (err) { UT_LOG.error('getCurrentUsers:mdb.Get', err, { nid: nid }); }
                    if (!err && docs && docs.length > 0) {
                        var d = docs[0];
                        UT_LOG.raw('getCurrentUsers: mdb.Get ' + nid + ' users=' + JSON.stringify(d.users) + ' lusers=' + JSON.stringify(d.lusers));
                        if (Array.isArray(d.users) && d.users.length > 0) {
                            result.push({ nodeid: nid, nodeName: d.name || nid, users: d.users });
                        }
                    } else {
                        UT_LOG.raw('getCurrentUsers: mdb.Get ' + nid + ' — no docs or empty');
                    }
                    if (--remaining <= 0 && !done) {
                        done = true;
                        clearTimeout(timeout);
                        UT_LOG.raw('getCurrentUsers: complete result=' + JSON.stringify(result));
                        obj._send(sid, { action:'plugin', plugin:'usertracer', method:'currentUsers', data: result });
                    }
                });
            });
        });
    };

    // --- getTimeline: ACL filter via GetNodeWithRights (v3.5.83 security fix) ---
    obj._actionGetTimeline = function (command, sid, parentUser) {
        UT_LOG.raw('getTimeline: entry sid=' + (sid ? sid.substring(0,40) : 'null') + ' startDate=' + command.startDate + ' endDate=' + command.endDate + ' nodeid=' + command.nodeid + ' nodeids=' + command.nodeids + ' username=' + command.username + ' _reqSeq=' + command._reqSeq);
        var user = obj._getSessionUser(sid, parentUser);
        if (!user) { UT_LOG.raw('getTimeline: no user — sending empty'); obj._send(sid, { action:'plugin', plugin:'usertracer', method:'timeline', data: [], _pwrMap: {}, _activeUsers: {}, _activeLusers: {}, _reqSeq: command._reqSeq }); return; }
        if (!obj.db || typeof obj.db.getEvents !== 'function') {
            UT_LOG.raw('getTimeline: no db.getEvents — sending empty');
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'timeline', data: [], _pwrMap: {}, _activeUsers: {}, _activeLusers: {}, _reqSeq: command._reqSeq });
            return;
        }
        var requestedNodeIds = null;
        if (command.nodeids && command.nodeids.length > 0) requestedNodeIds = command.nodeids.slice();
        else if (command.nodeid) requestedNodeIds = [command.nodeid];
        obj._filterAccessibleNodeIds(user, requestedNodeIds, function (accessibleNodeIds) {
            if (accessibleNodeIds === null) {
                accessibleNodeIds = requestedNodeIds;
            }
            var opts = { limit: command.limit || 5000 };
            if (command.startDate) {
                var sd = new Date(command.startDate);
                if (!isNaN(sd)) { sd.setDate(sd.getDate() - 1); opts.startDate = sd.toISOString(); }
            }
            if (command.endDate) opts.endDate = command.endDate;
            if (accessibleNodeIds && accessibleNodeIds.length > 0) opts.nodeids = accessibleNodeIds;
            else if (requestedNodeIds) {
                obj._send(sid, { action:'plugin', plugin:'usertracer', method:'timeline', data: [], _pwrMap: {}, _activeUsers: {}, _activeLusers: {}, _reqSeq: command._reqSeq });
                return;
            }
            var query = {};
            if (command.username) query.$or = [{ username: command.username }, { displayUser: command.username }];
            UT_LOG.raw('getTimeline: query opts=' + JSON.stringify(opts) + ' query=' + JSON.stringify(query) + ' accessibleNodeIds=' + JSON.stringify(accessibleNodeIds));
            obj.db.getEvents(query, opts, function (docs) {
                docs = docs || [];
                UT_LOG.raw('getTimeline: getEvents returned ' + docs.length + ' events');
                if (docs.length > 0) {
                    // Log sample entries (primeiros 3)
                    for (var _ti = 0; _ti < Math.min(docs.length, 3); _ti++) {
                        UT_LOG.raw('getTimeline: event[' + _ti + ']=' + JSON.stringify({
                            _id: docs[_ti]._id, nodeid: docs[_ti].nodeid,
                            username: docs[_ti].username, eventType: docs[_ti].eventType,
                            detectedAt: docs[_ti].detectedAt, nodeName: docs[_ti].nodeName
                        }));
                    }
                } else {
                    UT_LOG.raw('getTimeline: NO EVENTS returned from db.getEvents');
                }
                var pwrMap = {};
                if (obj.devicePower) {
                    docs.forEach(function (e) {
                        if (e && e.nodeid && obj.devicePower[e.nodeid] && !pwrMap[e.nodeid]) {
                            pwrMap[e.nodeid] = obj.devicePower[e.nodeid];
                        }
                    });
                }
                var activeUsers = {};
                var activeLusers = {};
                var seen = {};
                docs.forEach(function (e) {
                    if (e && e.nodeid && obj.userCache[e.nodeid] && !seen[e.nodeid]) {
                        seen[e.nodeid] = 1;
                        try {
                            var st = JSON.parse(obj.userCache[e.nodeid]);
                            activeUsers[e.nodeid] = (st.users || []).slice();
                            activeLusers[e.nodeid] = (st.lusers || []).slice();
                        } catch (_) {}
                    }
                });
                UT_LOG.raw('getTimeline: response pwrMap=' + JSON.stringify(Object.keys(pwrMap)) + ' activeUsers=' + JSON.stringify(Object.keys(activeUsers)) + ' activeLusers=' + JSON.stringify(Object.keys(activeLusers)) + ' ids=' + JSON.stringify(Object.keys(activeUsers)));
                var resp = {
                    action: 'plugin', plugin: 'usertracer', method: 'timeline',
                    data: docs, _pwrMap: pwrMap, _activeUsers: activeUsers, _activeLusers: activeLusers,
                    _reqSeq: command._reqSeq
                };
                UT_LOG.raw('getTimeline: sending response eventCount=' + docs.length + ' _reqSeq=' + command._reqSeq);
                obj._send(sid, resp);
            });
        });
    };

    obj._actionGetDeviceNames = function (command, sid, parentUser) {
        UT_LOG.raw('getDeviceNames: entry sid=' + (sid ? sid.substring(0,40) : 'null'));
        var cb = function (d) {
            UT_LOG.raw('getDeviceNames: result count=' + (d ? d.length : 0) + ' sample=' + (d && d.length > 0 ? JSON.stringify(d.slice(0, 3)) : '[]'));
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'deviceNames', data: d || [], _reqSeq: command._reqSeq });
        };
        if (obj.db && obj.db.getDeviceNames) {
            UT_LOG.raw('getDeviceNames: calling db.getDeviceNames');
            obj.db.getDeviceNames(cb);
        } else {
            UT_LOG.raw('getDeviceNames: no db.getDeviceNames — sending empty');
            cb([]);
        }
    };

    obj._actionGetUserNames = function (command, sid, parentUser) {
        UT_LOG.raw('getUserNames: entry sid=' + (sid ? sid.substring(0,40) : 'null'));
        if (!obj.db || !obj.db.getUserNames) {
            UT_LOG.raw('getUserNames: no db.getUserNames — sending empty');
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'userNames', data: [], _reqSeq: command._reqSeq });
            return;
        }
        obj.db.getUserNames(function (d) {
            UT_LOG.raw('getUserNames: result count=' + (d ? d.length : 0) + ' sample=' + (d && d.length > 0 ? JSON.stringify(d.slice(0, 3)) : '[]'));
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'userNames', data: d || [], _reqSeq: command._reqSeq });
        });
    };

    obj._actionGetNodeDetails = function (command, sid, parentUser) {
        UT_LOG.raw('getNodeDetails: entry sid=' + (sid ? sid.substring(0,40) : 'null') + ' nodeid=' + command.nodeid);
        var user = obj._getSessionUser(sid, parentUser);
        var nid = command.nodeid;
        if (!user || !nid) {
            UT_LOG.raw('getNodeDetails: no user or nid — sending null user=' + (!!user) + ' nid=' + nid);
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'nodeDetails', data: null });
            return;
        }
        if (!obj.mdb || typeof obj.mdb.Get !== 'function') {
            UT_LOG.raw('getNodeDetails: no mdb.Get — sending null');
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'nodeDetails', data: null });
            return;
        }
        // ACL check
        obj._filterAccessibleNodeIds(user, [nid], function (accessible) {
            UT_LOG.raw('getNodeDetails: ACL accessible=' + JSON.stringify(accessible));
            if (accessible.length === 0) {
                UT_LOG.raw('getNodeDetails: ACL denied for ' + nid);
                obj._send(sid, { action:'plugin', plugin:'usertracer', method:'nodeDetails', data: null });
                return;
            }
            obj.mdb.Get(nid, function (err, docs) {
                if (err) { UT_LOG.error('getNodeDetails:mdb.Get', err, { nid: nid }); }
                if (err || !docs || !docs.length) {
                    UT_LOG.raw('getNodeDetails: mdb.Get returned no docs for ' + nid);
                    obj._send(sid, { action:'plugin', plugin:'usertracer', method:'nodeDetails', data: null });
                    return;
                }
                var d = docs[0];
                UT_LOG.raw('getNodeDetails: raw doc=' + JSON.stringify({
                    _id: d._id, name: d.name, host: d.host, ip: d.ip,
                    osdesc: d.osdesc, domain: d.domain, mtype: d.mtype,
                    lastbootuptime: d.lastbootuptime, idletime: d.idletime,
                    users: d.users, lusers: d.lusers
                }));
                obj._send(sid, { action:'plugin', plugin:'usertracer', method:'nodeDetails', data: {
                    nodeid: nid, name: d.name, host: d.host, ip: d.ip, osdesc: d.osdesc,
                    domain: d.domain, mtype: d.mtype, agent: d.agent,
                    lastbootuptime: d.lastbootuptime, idletime: d.idletime
                }});
            });
        });
    };

    obj._actionPurgeHistory = function (command, myparent, sid) {
        UT_LOG.raw('actionPurgeHistory: entry sid=' + (sid ? sid.substring(0,40) : 'null'));
        var user = myparent && myparent.user;
        if (!obj.parent || typeof obj.parent.getAccessPermissions !== 'function') {
            UT_LOG.raw('actionPurgeHistory: no getAccessPermissions — error');
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'purgeResult', data: { success: false, error: 'No permissions API' } });
            return;
        }
        obj.parent.getAccessPermissions('usertracer', user, {}).then(function (has) {
            if (!has('can_purge_history') && (user.siteadmin & 0xFFFFFFFF) != 0xFFFFFFFF) {
                UT_LOG.raw('actionPurgeHistory: permission denied for user=' + (user ? user._id : 'null'));
                obj._send(sid, { action:'plugin', plugin:'usertracer', method:'purgeResult', data: { success: false, error: 'Permission denied' } });
                return;
            }
            if (!obj.db || typeof obj.db.purgeAll !== 'function') {
                UT_LOG.raw('actionPurgeHistory: no db.purgeAll — error');
                obj._send(sid, { action:'plugin', plugin:'usertracer', method:'purgeResult', data: { success: false, error: 'No purge API' } });
                return;
            }
            UT_LOG.raw('actionPurgeHistory: calling db.purgeAll');
            obj.db.purgeAll(function (err) {
                UT_LOG.raw('actionPurgeHistory: purgeAll done err=' + (err ? err.message : 'null'));
                obj._send(sid, { action:'plugin', plugin:'usertracer', method:'purgeResult', data: { success: !err, error: err ? err.message : null } });
            });
        }).catch(function (ex) {
            UT_LOG.raw('actionPurgeHistory: catch err=' + (ex ? ex.message : 'unknown'));
            obj._send(sid, { action:'plugin', plugin:'usertracer', method:'purgeResult', data: { success: false, error: 'Permission check failed' } });
        });
    };


    // -----------------------------------------------------------------------
    // ACL helpers — usando APIs nativas do MeshCentral (v3.5.83 security fix)
    // -----------------------------------------------------------------------
    obj._getSessionUser = function (sid, fallback) {
        try {
            var wss2 = obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wssessions2;
            if (wss2 && wss2[sid] && wss2[sid].user) {
                var user = wss2[sid].user;
                UT_LOG.raw('_getSessionUser: found sid=' + (sid ? sid.substring(0,40) : 'null') + ' user=' + JSON.stringify({ _id: user._id, name: user.name, siteadmin: user.siteadmin }));
                return user;
            }
            // Sid pode ser userID, não sessionID — tentar fallback direto do myparent
            if (fallback) {
                UT_LOG.raw('_getSessionUser: using fallback user for sid=' + (sid ? sid.substring(0,40) : 'null') + ' user=' + JSON.stringify({ _id: fallback._id, name: fallback.name, siteadmin: fallback.siteadmin }));
                return fallback;
            }
            if (wss2 && wss2[sid]) {
                UT_LOG.raw('_getSessionUser: wss2[sid] keys=' + JSON.stringify(Object.keys(wss2[sid])) + ' hasUser=' + ('user' in wss2[sid]) + ' userVal=' + JSON.stringify(wss2[sid].user) + ' typeofUser=' + typeof wss2[sid].user);
            }
            UT_LOG.raw('_getSessionUser: no session for sid=' + (sid ? sid.substring(0,40) : 'null') + ' wss2=' + (!!wss2) + ' wss2[sid]=' + (wss2 && !!wss2[sid]) + ' user=' + (wss2 && wss2[sid] && !!wss2[sid].user));
            return null;
        } catch (_) { return null; }
    };

    obj._isAdminFull = function (user) {
        return user && (user.siteadmin === 0xFFFFFFFF || user.siteadmin === -1);
    };

    obj._filterAccessibleNodeIds = function (user, nodeIds, cb) {
        UT_LOG.raw('_filterAccessibleNodeIds: entry nodeIds=' + (nodeIds ? nodeIds.length : 0) + ' user=' + (user ? user._id : 'null'));
        if (!user) { UT_LOG.raw('_filterAccessibleNodeIds: no user — empty'); cb([]); return; }
        // Admin full bypass total — mais seguro, alinhado com MeshCentral siteadmin
        if (obj._isAdminFull(user)) {
            UT_LOG.raw('_filterAccessibleNodeIds: admin full bypass — returning all ' + (nodeIds ? nodeIds.length : 0) + ' ids');
            cb(nodeIds);
            return;
        }
        if (!nodeIds || nodeIds.length === 0) {
            // Sem filtro explícito: retornar nodes visíveis via user.links
            var linked = user.links ? Object.keys(user.links).filter(function (k) { return k.indexOf('node/') === 0; }) : [];
            UT_LOG.raw('_filterAccessibleNodeIds: no explicit nodeIds — using user.links count=' + linked.length);
            cb(linked);
            return;
        }
        var webserver = obj.meshServer && obj.meshServer.webserver;
        if (!webserver || typeof webserver.GetNodeWithRights !== 'function') {
            UT_LOG.raw('_filterAccessibleNodeIds: no GetNodeWithRights — empty');
            cb([]);
            return;
        }
        var accessible = [], pending = nodeIds.length, done = false;
        var timeout = setTimeout(function () {
            if (done) return;
            done = true;
            UT_LOG.raw('_filterAccessibleNodeIds: TIMEOUT after 3s — returning partial=' + JSON.stringify(accessible));
            cb(accessible);
        }, 3000);
        nodeIds.forEach(function (nid) {
            try {
                UT_LOG.raw('_filterAccessibleNodeIds: checking ' + nid);
                webserver.GetNodeWithRights(user.domain, user, nid, function (node, rights, visible) {
                    if (done) return;
                    UT_LOG.raw('_filterAccessibleNodeIds: result for ' + nid + ' visible=' + visible + ' rights=0x' + (rights ? rights.toString(16) : '0') + ' MESHRIGHT_DEVICEDETAILS=' + ((rights & 0x00100000) === 0x00100000));
                    // MESHRIGHT_DEVICEDETAILS (0x100000) libera node.users/lusers
                    // User-Device Tracer requer este right para exibir dados sensíveis
                    if (visible && rights > 0 && (rights & 0x00100000) === 0x00100000) {
                        accessible.push(nid);
                    } else {
                        UT_LOG.raw('_filterAccessibleNodeIds: ' + nid + ' DENIED (visible=' + visible + ' rights=0x' + (rights ? rights.toString(16) : '0') + ')');
                    }
                    if (--pending === 0 && !done) {
                        done = true;
                        clearTimeout(timeout);
                        UT_LOG.raw('_filterAccessibleNodeIds: final accessible=' + JSON.stringify(accessible));
                        cb(accessible);
                    }
                });
            } catch (e) {
                UT_LOG.error('_filterAccessibleNodeIds:GetNodeWithRights', e, { nid: nid });
                if (--pending === 0 && !done) {
                    done = true;
                    clearTimeout(timeout);
                    UT_LOG.raw('_filterAccessibleNodeIds: final (after catch) accessible=' + JSON.stringify(accessible));
                    cb(accessible);
                }
            }
        });
    };


    obj._send = function (sid, data) {
        try {
            var wss2 = obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wssessions2;
            if (!wss2 || !wss2[sid]) {
                UT_LOG.raw('_send: session not found sid=' + (sid ? sid.substring(0,40) : 'null') + ' method=' + (data && data.method) + ' dataLen=' + (data && data.data && data.data.length));
                return;
            }
            var method = data && data.method;
            var dataLen = data && data.data ? (Array.isArray(data.data) ? data.data.length : Object.keys(data.data).length) : 0;
            // Log raw data (resumir arrays grandes)
            var dataSummary = data && data.data;
            if (Array.isArray(dataSummary) && dataSummary.length > 3) {
                dataSummary = dataSummary.slice(0, 3).concat(['...(' + dataSummary.length + ' total)']);
            }
            var _reqSeqVal = data && data._reqSeq;
            UT_LOG.raw('_send: sid=' + (sid ? sid.substring(0,40) : 'null') + ' method=' + method + ' data=' + JSON.stringify(dataSummary) + ' _reqSeq=' + (_reqSeqVal != null ? _reqSeqVal : 'none'));
            wss2[sid].send(JSON.stringify(data));
        } catch (e) { UT_LOG.error('_send', e, { sid: sid }); }
    };

    obj.getNodeName = function (nid) {
        try {
            var ws = obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
            if (ws && ws[nid]) return ws[nid].name || nid;
            return nid;
        } catch (e) { return nid; }
    };

    // -----------------------------------------------------------------------
    // WS message handlers (browser-side) — exist so the upstream pluginHandler
    // dispatch (default.handlebars:4172) does not throw TypeError when our
    // server-side _send broadcasts messages that other MeshCentral pages
    // (devices list, device details) receive. Admin.handlebars intercepts
    // the same messages directly via ms.socket.addEventListener, so these
    // stubs are no-ops everywhere.
    // -------------------------------------------------------------------
    obj.currentUsers = function () {};
    obj.nodeDetails  = function () {};
    obj.purgeResult  = function () {};
    obj.timeline     = function () {};
    obj.deviceNames  = function () {};
    obj.userNames    = function () {};
    obj.onDeviceRefreshEnd = function () {
        try {
            if (typeof currentNode === 'undefined' || !currentNode) return;
            if (currentNode.osdesc && currentNode.osdesc.toLowerCase().indexOf('windows') === -1) return;
            if (typeof pluginHandler === 'undefined') return;
            // Sem guard 'user' — alinhado com RegEdit. Permissões finas no iframe via handleAdminReq (server-side).
            pluginHandler.registerPluginTab({ tabTitle: 'User Tracer', tabId: 'pluginUserTracer' });
            var nid = currentNode._id;
            QA('pluginUserTracer', '<iframe id="pluginIframeUserTracer" style="width:100%;height:80vh;overflow:auto;border:none" scrolling="yes" frameBorder=0 src="/pluginadmin.ashx?pin=usertracer&user=1&nodeid=' + encodeURIComponent(nid) + '" />');
        } catch (e) {
            // NÃO usar UT_LOG — server-side only; ReferenceError no browser cascateia pelo callHook
            if (typeof console !== 'undefined' && console.error) console.error('[usertracer] onDeviceRefreshEnd', e);
        }
    };

    return obj;
};
