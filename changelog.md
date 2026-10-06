## 3.5.97 (2026-10-06)

### Fixed
- **Log spam `[UT]` com UT_DEBUG=false**: `UT_LOG.raw` (usertracer.js:47) não era gateado pela flag — apenas `debug` e `info` estavam. 119 chamadas `raw` (checkNode, scanNow, hook_processAgentData, etc) imprimiam sempre, poluindo o console do servidor em produção. Fix: adicionado `if (!UT_DEBUG) return;` no `raw`. `[UT ERROR]` permanece sempre ativo.

## 3.5.95 (2026-08-05)

### Fixed
- **Device tab Gantt nunca aplicava o override lock→login** (`views/device.handlebars:_renderGantt`): o override chamava `liveState(s.nodeid, ...)`, mas `buildSessions` da device tab não popula `s.nodeid` (só admin popula). Resultado: `_activeUsers[undefined]` → `[]` → `liveState` sempre retornava "Offline" → trailing open session com `state='lock'` nunca era rebaixado para 'login'. Fix: usar a global `nodeid` (sempre o device atual) em vez de `s.nodeid`. Admin já estava correto porque lá `buildSessions` popula `s.nodeid`.
- **Device tab: response de timeline descartada como "não solicitada"** (`views/device.handlebars:loadHistory` + WS handler). Bug: `_inflight = null` era setado ANTES de `ms.send()` dentro do setTimeout, então quando o response chegava (milissegundos depois), o handler via `_inflight === null` e descartava. Drop completo do mecanismo `_inflight` — `_reqSeq` (já presente no handler) é suficiente para descartar responses stale. Substituído por debounce de 100ms via `_sendDebounced` keyed em 'loadHistory|startDate|endDate' para evitar rajadas do date-picker onchange.

### Notes
- A v3.5.94 foi commitada mas não foi capaz de fixar o device tab completamente por causa desses dois bugs latentes. v3.5.95 fecha o ciclo: status badge + Gantt override ambos funcionam em admin e device tabs.
- O memory `gantt-builder` deve refletir que `device.handlebars:buildSessions` NÃO popula `s.nodeid` (apenas `user, display, start, end, state, open`). Admin popula. Isso é divergência intencional entre os dois builds — admin agrupa por device+user, device agrupa por user (uma linha por usuário).


## 3.5.94 (2026-08-05)

### Fixed
- **Status "Bloqueado" errado quando usuário está online (e vice-versa)**
  - **Backend** (`usertracer.js:_actionGetTimeline`): novo campo `_activeLusers` na response WS, espelhando `_activeUsers` mas com a lista de usuários bloqueados (`doc.lusers`). Os 4 caminhos de response (sucesso + 3 fallbacks) emitem o campo.
  - **Helper `liveState(nodeid, user)`** adicionado em ambos os views: se user está em `_activeUsers[nodeid]` E em `_activeLusers[nodeid]` → **Bloqueado**; só em `_activeUsers` → **Online**; em nenhum → **Offline**. Source-of-truth é o estado atual do agente, não o último evento histórico.
  - **Override no Gantt** (`_renderGantt` em ambos os views): sessões abertas agora re-resolvem o estado via `liveState`. Trailing segment com `state='lock'` é rebaixado para `login` se o usuário está atualmente online e desbloqueado. Trailing segment com `state='logout'` mantém-se se usuário realmente não está ativo.

### Notes
- **Não muda o contrato WS existente**: clientes antigos continuam recebendo `_activeUsers` (não-regardless). O novo campo `_activeLusers` é aditivo — frontend sem o helper ignora e cai no comportamento anterior (lastEventType). Migração limpa é forward-compatible.
- `_activeLusers` é populado do `obj.userCache[nodeid]` (cache populado pelo scanner 30s), mesma fonte do `_activeUsers`. TTL implícito: 30s entre scans. Mesma garantia de freshness do live-state.

## 3.5.93 (2026-07-29)

### Fixed
- **NeDB crash loop com `11% of data file is corrupt`**: após restart abrupto durante compaction, o `@seald-io/nedb` recusava carregar com `Error: 11% of the data file is corrupt, more than corruptAlertThreshold (10%). Cautiously refusing to start NeDB to prevent dataloss`. Crash loopava o MeshCentral a cada 5s. Fix em `db.js:35-68`: (1) `corruptAlertThreshold: 0.5` em vez do default 10% — tolera até 50% de corrupção (cenário real de restart mid-write); (2) autocompaction subiu de 60s para 300s (`setAutocompactionInterval(300000)`) reduzindo write contention com o scanner; (3) recovery path que deleta o `.db` + `.db~` e re-inicializa quando o erro detectado é de corrupção (regex `/corrupt/i` na mensagem), uma vez por processo (`_nedbRecovered` flag previne loop). MeshCentral agora sobe mesmo com DB parcialmente corrompido.

### Notes
### Notes
- **Ação manual recomendada (uma vez)**: deletar `C:\Program Files\Open Source\MeshCentral\meshcentral-data\plugin-usertracer-events.db` e reiniciar MeshCentral para tirar do estado crash-loop atual. O fix previne recorrência, mas o arquivo já corrompido precisa de reset manual.


## 3.5.92 (2026-07-29)

### Fixed
- **Gantt vazio re-renderiza com dados não solicitados** (`views/admin.handlebars:182 handleTimeline`): o handler WS chamava `renderTimeline(d.data, d._pwrMap)` incondicionalmente ao receber qualquer response `timeline`, sobrescrevendo o Gantt com pushes do servidor, retries de rede ou respostas de requests canceladas. Adicionado `_ganttOwner` (`'user'` | `'dev'` | `null`) setado em `loadXrefUser`/`loadXrefDev` e limpo em `resetUserFilter`/`resetDevFilter`. O `renderTimeline` agora só é chamado quando `_ganttOwner` bate com `_reqUser`/`_reqDev` ativo — respostas stale ou sem filtro ativo são descartadas silenciosamente com `WS_TL_SKIP`.
- **Mesmo bug em `views/device.handlebars:280`**: o WS handler chamava `renderGantt` sem gate de request ativa. Adicionado `_reqSeq` à declaração de estado e à request em `loadHistory` (linha 126-127). Handler agora valida `d._reqSeq !== _reqSeq` antes de renderizar — descarte via `WS_TL_STALE`. Defesa secundária via `_inflight === null` (request não foi feita pelo user) com log `WS_TL_NOINFLIGHT`.
- **Filtro A + response de filtro B sobrescreve Gantt**: ao buscar "alexandre.matias" depois mudar para um device, a response tardia do filtro antigo re-renderizava o Gantt com dados do usuário, sobrescrevendo a seleção do device. Agora o gate `_ganttOwner === 'dev' && _reqDev` previne.

## 3.5.91 (2026-07-29)

### Fixed
- **`ReferenceError: UT_LOG is not defined` no browser** (`usertracer.js:911 onDeviceRefreshEnd`): a função roda no browser via `prepExports`, mas o `catch` chamava `UT_LOG.error()` que é variável server-side. Se algo no `try` lançasse, o `catch` propagava `ReferenceError` e o `callHook` upstream matava o dispatch de todos os outros plugins naquela página. Trocado por `console.error` no `catch` (browser-safe). Também removido o guard `user`/`siteadmin` (alinhado com RegEdit, que não filtra — permissões finas vão via `handleAdminReq` server-side).
- **Device tab não registrava aba "User Tracer"**: o `onDeviceRefreshEnd` tinha dois guards (`user` e `siteadmin`) que bails silencionavam antes de chamar `registerPluginTab` em alguns fluxos. Após o fix do `UT_LOG`, a tab passa a aparecer consistentemente em todos os devices Windows.
- **Drag-to-zoom na timeline do device tab**: `views/device.handlebars` agora tem drag-select idêntico ao admin (`setupGanttDrag`, `zoomTo`, `resetZoom` em linhas 252-277). Track do Gantt marca com `class="gantt-track" data-rs data-re` (linhas 168, 180) para que o `timeAt(clientX)` calcule o range a partir do rect do track. Botão `↺` (linha 48) aparece durante zoom e chama `resetZoom`. `_viewRange`/`_baseRange` (linha 67) preservam o zoom durante `zoomTo`/`resetZoom`/`renderGantt`. `_pwrMap` cacheado no client (linha 216) para re-renders sem WS.
- **`_stopped` flag ordering** (`usertracer.js:141-142 server_startup`): o `stopScanner()` é chamado antes de `startScanner()` dentro de `server_startup`, e seta `_stopped = true`. O `startScanner()` checava `if (_stopped) return;` e bailava imediatamente — o timer `setInterval` nunca era criado. Resultado: scanner só processava agentes que disparavam `hook_processAgentData` ou `hook_agentCoreIsStable`, não os conectados sem hook ativo. Swap das linhas 141/142: `_stopped = false` agora vem ANTES de `startScanner()`. Sintoma em produção: scanner processava 1-3 dos 10 agents por ciclo, perdia os outros até alguma mensagem de hook chegar.

## 3.5.90 (2026-07-29)

### Fixed
- **`TypeError: pluginHandler[message.plugin][message.method] is not a function`** in non-admin MeshCentral pages (devices list, device details — `viewmode=42`). Root cause: server-side `_send` broadcasts 6 message methods (`currentUsers`, `timeline`, `deviceNames`, `userNames`, `nodeDetails`, `purgeResult`), but only `onDeviceRefreshEnd` was exported to the browser via `obj.exports`. The upstream browser dispatcher (`default.handlebars:4172`) tries `pluginHandler['usertracer'][message.method]` for any incoming WS message, throwing TypeError when the method is missing. Fix: added no-op stubs `obj.currentUsers`, `obj.nodeDetails`, `obj.purgeResult` and listed them in `obj.exports`. The admin.handlebars intercepts these directly via `ms.socket.addEventListener('message', …)` and is unaffected.

### Added
- **Tests for WS message stubs** (`tests/unit/storeEvent.test.js`): verifies `currentUsers`, `nodeDetails`, `purgeResult` are in `obj.exports`, are functions, and are no-ops when called with arbitrary args (including a typical WS payload).

## 3.5.89 (2026-07-29)


### Fixed
- **`EPERM` on `analysis/00-README.md` in plugin install**: root cause was `downloadUrl` in `config.json` pointing to `https://github.com/jukmisael/Tracer-Plugin-MeshCentral/archive/master.zip` — the full GitHub source archive containing `analysis/`, `tests/`, `meshcentral-core/`, `MESHCENTRAL-PLUGIN-GUIDE.md`, `.megamemory/`. MeshCentral extracts the whole zip to `meshcentral-data/plugins/usertracer/`. On next update, those dev-only files become permission-locked and the new extraction fails with `EPERM`.

### Added
- **`.github/workflows/release.yml`**: triggered on `v*` tag push, builds a clean plugin zip containing only runtime files (`usertracer.js`, `db.js`, `config.json`, `changelog.md`, `views/admin.handlebars`, `views/device.handlebars`), creates a GitHub release, and uploads the zip as a fixed-name asset (`usertracer.zip`). Validates that `config.json` version matches the tag.
- **`downloadUrl` switched** to `https://github.com/jukmisael/Tracer-Plugin-MeshCentral/releases/latest/download/usertracer.zip`. MeshCentral will now download only the clean runtime zip.
- **Manual install note**: existing installations must be removed and re-added (`Delete plugin` in MeshCentral admin → re-add the plugin URL) for the new `downloadUrl` to take effect, since `getPluginLatest` does not propagate `downloadUrl` from remote `config.json` to existing DB entries.

## 3.5.88 (2026-07-29)


### Added
- **Tests for `loadTimeline()` router** (12 tests in `tests/unit/loadTimeline.test.js`): verifies routing to `loadXrefUser` / `loadXrefDev` based on `_reqUser` / `_reqDev`, precedence (user wins), empty-state placeholder when no xref is active, and regression coverage for `onDateChange` / `resetZoom` / `zoomTo` (the call sites that triggered the original bug). Uses stub injection (no DOM/WS plumbing).
- **`tests/_helpers/view-runner.js`**: extracts the inline `<script>` from a Handlebars view and runs it in a `vm` sandbox with a minimal DOM shim, exposing globals/functions for testing. Future view-level tests can reuse this helper.
- **`function onDateChange()`**: same pattern as v3.5.87 bug — referenced from HTML `onchange` attributes (lines 73-74) but never defined in the script block. Added the missing definition so changing the date inputs no longer throws `ReferenceError`.

## 3.5.87 (2026-07-29)


### Fixed
- **ReferenceError: `loadTimeline` is not defined** in `views/admin.handlebars` (lines 243, 245, 253). Function had been removed in an earlier refactor but the call sites were not updated. Triggered by clicking the reset-zoom button before any cache was populated. Added router that delegates to `loadXrefUser()` / `loadXrefDev()` when xref is active, or shows the empty-state message otherwise.

## 3.5.86 (2026-07-29)


### Added
- **Testes para `hook_agentCoreIsStable` e `hook_processAgentData`** (14 testes): cobrem debounce de 2s, normalização de `nodeid` (string/object/nodeid/_id), idempotência (múltiplas chamadas = 1 checkNode), error handling (exceções em mdb.Get são capturadas sem crash), e no-op quando `_stopped=true`. Estes hooks são os triggers principais do scanner e estavam sem cobertura.

## 3.5.85 (2026-07-29)


### Changed
- **DRY applied to shared frontend utilities** (`esc`, `splitUser`, `ymd`, `fmtDur`, `eventMeta`): confirmed byte-identical between `views/admin.handlebars` and `views/device.handlebars`. Added comment block above each section documenting the convention ("When modifying, mirror to both files"). MeshCentral upstream does not implement `?include=1` for plugin views, so files are inlined rather than extracted to a shared asset.
- **`eventMeta` endLabel standardizado para `null`** (era `''` em admin.handlebars, `null` em device.handlebars). Comportamento idêntico via `|| fmtDate()` em ambos callers (linhas 402 e 419 admin). `null` é o "fix" pós-v3.5.x mais limpo.
- **`fmtDate` variants preservados** (admin: `dd/mm HH:MM`, device: `toLocaleString()`): UX intencional, não consolidados.
- **`dlog` mantém `max` diferente** (admin: 80, device: 60): preservado como variação intencional.

### Notes
- Análise completa em análise DRY feita anteriormente (não publicada). Conclusão: **5 funções já são 100% DRY**, `_renderGantt` e CSS têm divergências intencionais (admin agrupa por device, device por user; CSS tem border-radius 3px vs 2px). `_renderGantt` não foi unificado porque tem mudanças recentes em v3.5.82/v3.5.84 e merece estabilidade.
- Adicionar `_shared.js` / `_base.css` como assets do plugin exigiria suporte a `?include=1` no upstream, que **não existe** (verificado em `pluginHandler.js` e `webserver.js`). A escolha foi inlinear nos templates.


## 3.5.84 (2026-07-29)

### Fixed
- **Lock/unlock detection**: scanner nunca emitia `userUnlock` quando user permanecia em `currentUsers` mas saía de `currentLusers`. Lógica corrigida em `usertracer.js:240-247`: novo branch `prevLusers.forEach` que detecta user que estava locked e não está mais.
- **Mocks de teste**: `buildMock` agora tem `mdb.Get` default para evitar erro silencioso quando `mdb = null` em testes.


## 3.5.83 (2026-07-29)

### Security
- **ACL filter em serveraction**: `getTimeline`, `getCurrentUsers`, `getNodeDetails` agora chamam `_filterAccessibleNodeIds(user, nodeIds, cb)` que usa `webserver.GetNodeWithRights` nativo do MeshCentral. User non-admin que conhece um `nodeid` e tenta `getTimeline(nodeid=X)` recebe `data:[]` em vez de events do node. Requer `MESHRIGHT_DEVICEDETAILS` (0x100000) para visualizar dados sensíveis (alinhado com UI nativo). Admin full bypass via `manageAllDeviceGroups`. Implementação em `usertracer.js:421-550` (helpers em 556-623).

### Notes
- **Não muda contratos WS**: response shape idêntico (`method:timeline`, `data`, `_pwrMap`, `_activeUsers`, `_reqSeq`). Apenas o conteúdo de `data` é filtrado.
- **Frontend não precisa mudar**: backend já filtra; frontend renderiza apenas o que recebe.
- **`getDeviceNames`/`getUserNames` não filtram**: retornam listas agregadas sem nodeids detalhados. Adicionar filtro aqui é enhancement futuro, não security fix.
- Auditoria completa em `analysis/ADR-002-acl-native.md` (patterns nativos + MESHRIGHT_* constants + cascade).


## 3.5.82 (2026-07-29)

### Fixed
- **Spurious zero-duration segments at bar start when session crosses midnight**: `buildSessions` agora clampa `end` com `Math.max(rs, Math.min(re, t))` e descarta segments onde `end <= start`. Antes, eventos do dia anterior (com `t < rs`) geravam segments com `start=rs, end=t<rs`, que após clamp de start ficavam com `dur=0` mas ainda renderizavam (graças ao `min-width:4px`) como fragmentos invisíveis empilhados em `left:0%`. Aplicado em `admin.handlebars` e `device.handlebars` (que também não tinha nenhum clamp por `rs`/`re`).

## 3.5.81 (2026-07-29)

### Fixed
- **Gantt bar compressed when session.start < rangeStart**: `barMs` agora usa a span visível (`barEnd-barStart` = `min(lst.end,re) - max(fst.start,rs)`) em vez de `lst.end-fst.start`. Segmentos posicionados com `left:X%`/`width:X%` absolutos relativos ao bar (não mais `flex:0 0` + `margin-left` que acumulava drift com gaps entre segments). Cada segment clipado à span visível via `visStart`/`visEnd`/`visDur`. Aplicado em `admin.handlebars` e `device.handlebars`.

## 3.5.80 (2026-07-28)

### Fixed
- **Syntax error**: removed extra `}` from loadUserNames function (double closing brace)

## 3.5.79 (2026-07-28)
### Fixed
- **Syntax error**: removed extra `}` after buildSessions function that caused `Unexpected token '}'` on page load

## 3.5.78 (2026-07-28)
### Fixed
- **Gantt fix**: removed `routed` flag that was blocking renderTimeline on initial load; WS handler now always calls renderTimeline (matching v3.5.70 behavior)
### Added
- Comprehensive debug tracing at every step: WS handler entry, renderTimeline entry/exit, buildSessions entry/exit, _renderGantt entry, page init, loadTimeline, onDateChange, loadXrefUser/Dev
- Backend logging: UT RESP logs for all timeline send paths, db.Get results for activeUsers, getEvents result count

## 3.5.77 (2026-07-28)
### Fixed
- **Gantt not rendering**: PH callback was processing timeline before WS handler, consuming _xrefPending and rendering with stale state. PH timeline callback now only logs; WS handler owns all rendering.

## 3.5.76 (2026-07-28)
### Added
- Debug logging in WS timeline handler and renderTimeline to trace Gantt rendering flow

## 3.5.75 (2026-07-28)
### Fixed
- **Timeline overwrite**: WS handler now skips `renderTimeline` when xref already rendered the response. Prevents Gantt being overwritten by stale/auto-triggered responses.
- **buildSessions merge**: lock/unlock events now create sub-segments within a session instead of separate bars. Consecutive online segments are merged.

## 3.5.74 (2026-07-28)
### Fixed
- **Gantt segment sizing**: segments now use % of bar duration instead of track duration. Bars fill correctly.

## 3.5.73 (2026-07-28)
### Fixed
- **Removed dashed border** on open session Gantt bars. All bars now use solid border consistently.

## 3.5.72 (2026-07-28)
### Fixed
- **Gantt zoom broken**: reverted to percentage-based bar positioning with `flex:0 0 X%` + `min-width:4px` for segments. Bars now scale correctly at any zoom level.

## 3.5.71 (2026-07-28)
### Fixed
- **Gantt segment widths**: bars and segments now use pixel-based widths instead of percentages. Minimum 4px per segment. Bars no longer appear too small/short when zoomed in.

## 3.5.70 (2026-07-28)
### Fixed
- **Locked users no longer shown as Online**: `_activeUsers` override now only fixes stale 'offline' state. Sessions with `userLock` as last event correctly show "Bloqueado" (orange). Gantt bars and status badges respect the event type.

## 3.5.69 (2026-07-28)
### Fixed
- **Gantt bar "Bloqueado" when device is online**: open sessions now check `_activeUsers` (from `db.Get`). If user is active on the device, session state overridden to 'login' (green) regardless of last event type.

## 3.5.68 (2026-07-28)
### Fixed
- **User format mismatch**: `_activeUsers` from `doc.users` stores `DOMAIN\user` but events store plain `username`. Status comparison now normalizes both sides via `splitUser()` to match either format.

## 3.5.67 (2026-07-28)
### Changed
- **`_activeUsers` agora usa `db.Get(nodeId)`** do MeshCentral (fonte autoritativa) em vez do scanner cache. Fallback para `obj.userCache` se `db.Get` falhar.

## 3.5.66 (2026-07-28)
### Fixed
- **Status "Bloqueado" incorreto**: device tab e cross-reference cards agora usam `_activeUsers` (scanner cache) para determinar status real. Se o usuário está ativo no dispositivo, mostra "Online" mesmo que o último evento seja `userLock`. Server agora envia `_activeUsers` map no response do `getTimeline`.

## 3.5.65 (2026-07-28)
### Added
- **WS_RAW diagnostic logging**: WebSocket handler now logs ALL incoming messages (action, plugin, method, data type) BEFORE the plugin filter, to diagnose unexpected Gantt refresh triggers.
### Removed
- Dead code: `setRange()` function, `.btn-live` and `.btn-chip` CSS (unused since drag-to-select replaced preset buttons).

## 3.5.59 (2026-07-27)

### Added
- **Seta ▾** ao lado do input: clica para limpar o campo e mostrar TODAS as opções do datalist de uma vez, sem precisar digitar.
- **Restore on blur**: se clicar fora sem selecionar, o input volta a exibir a seleção anterior.

## 3.5.64 (2026-07-27)

### Fixed
- **Sessões recortadas ao período visível**: `buildSessions` agora clipa `start`/`end` ao range `rs`/`re`. Sessão lock de 27/07 21:04 até 28/07 08:43 agora mostra de 00:00 até 08:43 quando consultado28/07.

## 3.5.63 (2026-07-27)

### Fixed
- **Timeline vazio para período sem eventos detectados**: `getTimeline` agora busca eventos 1 dia antes do `startDate` para capturar sessões que começam antes mas se sobrepõem ao período consultado. Ex: sessão lock de 27/07 21:04 até 28/07 08:43 agora aparece ao consultar 28/07.

## 3.5.62 (2026-07-27)

### Changed
- **Dropdown: input é o próprio campo de busca**: a barra de seleção virou um `<input>` que ao clicar remove o readonly e vira campo de busca. Um só elemento — sem barra de seleção separada do search input.

## 3.5.61 (2026-07-27)

### Fixed
- **Removido placeholder duplicado**: removido "Filtrar..." do input de busca — o cursor piscante já indica campo de busca. Sem mais texto redundante com o "Selecione" da barra.

## 3.5.60 (2026-07-27)

### Changed
- **Dropdown reescrito do zero**: substituído `<datalist>` nativo por dropdown customizado (`sd-wrap`/`sd-sel`/`sd-drop`/`sd-opts`) com busca interna, lista de opções, e fechamento automático. Funciona em qualquer browser sem inconsistências.

## 3.5.58 (2026-07-27)

### Changed
- **Dropdown substituído por <input> + <datalist> nativo**: filtro de usuário/dispositivo agora usa `<input list="datalist-...">` com `<datalist>` — sem JS complexo, sem painel customizado. Digita para filtrar, clica na sugestão para selecionar, compatível com todos os navegadores.

## 3.5.57 (2026-07-27)

### Changed
- **Searchable dropdown estilo W3Schools**: dropdowns de usuário e dispositivo agora abrem um painel com campo de busca interno + lista filtrada. Clica no display → abre painel → digita para filtrar → clica na opção para selecionar. Select original mantido oculto para compatibilidade. Fecha ao clicar fora.

## 3.5.56 (2026-07-27)

### Changed
- **Barra de pesquisa integrada ao dropdown**: input de filtro agora fica visualmente DENTRO do componente (borda compartilhada com o select, sem gap).

## 3.5.55 (2026-07-27)

### Fixed
- **Domínio duplicado no dropdown**: `renderXrefDev` usava `g.domain + '\\' + un.user` para texto, que podia duplicar quando `displayUser` já inclui o domínio. Agora usa `g.user` (o `displayUser` original) diretamente.
- **Value do select**: usa `splitUser(g.user).user` (apenas username, sem domínio) — consistente com `renderUserNames`.

### Added
- **Barra de pesquisa nos dropdowns**: inputs de texto "Filtrar usuário..." e "Filtrar dispositivo..." acima de cada `<select>`. Filtra opções por texto em tempo real via `filterSel()`. Filtro reaplicado automaticamente após rebuild dos dropdowns.

## 3.5.54 (2026-07-27)

### Fixed
- **Stale response race**: server echoes `_reqSeq` from client request; frontend ignores responses where seq doesn't match latest sent. Prevents old query results (e.g. victor.portes) from overwriting current selection (e.g. alexandre.matias) when responses arrive out of order.
- **Triple WS execution**: removed broken `ws.onmessage` override that caused each message to fire 3× (addEventListener + onmessage wrapper + pluginHandler). Now uses clean `addEventListener` only.

## 3.5.53 (2026-07-27)

### Rewrite
- Gantt range selection reescrito: `.gantt-track` com `data-rs`/`data-re`, `timeAt(clientX)` linear, overlay em px no track
- Zoom client-side via `_eventsCache` (sem refetch); datepicker = range base do servidor
- Coluna DISPOSITIVO sticky (`position:sticky;left:0`) sem sobrepor track
- Estado limpo: `_viewRange` / `_baseRange` (remove `_fullRange`/`_savedRange`/`_selectedRange`)

## 3.5.52 (2026-07-27)

### Fixes
- Race condition: `_reqUser`/`_reqDev` ignoram respostas obsoletas de requisições anteriores

## 3.5.51 (2026-07-27)

### Fixes
- Flex container com `min-width:0` evita sobreposição da coluna DISPOSITIVO sobre o Gantt

## 3.5.50 (2026-07-27)

### Fixes
- Drag usa `_savedRange` (range atual do Gantt) em vez de `_fullRange` — arrastos subsequentes funcionam no zoom

## 3.5.49 (2026-07-27)

### Fixes
- getPct: usa `tickArea.getBoundingClientRect()` + `offsetWidth` para precisão máxima

## 3.5.48 (2026-07-27)

### Fixes
- getPct: usa scrollWidth e subtrai coluna 110px para precisão no drag

## 3.5.47 (2026-07-27)

### Ajustes
- Step dinâmico conforme span: 5min, 15min, 30min, 1h, 3h, 6h, 12h
- Label das ticks mostra HH:MM para steps < 1h

## 3.5.46 (2026-07-27)

### Ajustes
- Navegação ao node removida do clique na barra
- Duplo clique no segmento agora funciona (não conflita com onclick)

## 3.5.45 (2026-07-27)

### Features
- Botão ↺ para resetar zoom do Gantt
- Duplo clique no segmento → zoom no período do evento

## 3.5.44 (2026-07-27)

### Fixes
- `getPct` corrigido: inclui `scrollLeft` e `scrollWidth` (scroll horizontal quebrava o cálculo)

## 3.5.43 (2026-07-27)

### Fixes
- Drag-to-select: usa `_fullRange` em vez de `_savedRange` para evitar escala corrompida

## 3.5.42 (2026-07-27)

### Fixes
- `renderTimeline` usa `_selectedRange` quando disponível (zoom sub-dia)

## 3.5.41 (2026-07-27)

### Features
- Drag no Gantt usa `_selectedRange` com timestamps precisos (suporta sub-dia)
- Datepicker limpa `_selectedRange` ao mudar

## 3.5.40 (2026-07-27)

### Features
- Gantt com seleção por arrasto: clique e arraste no timeline para definir período
- Botões de preset removidos — apenas datepickers + drag

## 3.5.39 (2026-07-27)

### Features
- Presets de hora: 1h, 2h, 4h, 6h, 8h (padrão)
- Separador entre presets de dia e hora

## 3.5.38 (2026-07-27)

### Ajustes
- Botão "Aplicar" removido — filtros aplicam automaticamente
- Presets de período e datepicker auto-carregam timeline

## 3.5.37 (2026-07-27)

### Fixes
- `gotoUser`: busca por textContent (resolve \t escapando no onclick)
- Reset: limpa ambos painéis completamente

## 3.5.36 (2026-07-27)

### Fixes
- JS syntax: `}` faltando no `renderXrefDev`

## 3.5.35 (2026-07-27)

### Fixes
- JS syntax: `}` faltando no `renderXrefUser`

## 3.5.34 (2026-07-27)

### Ajustes
- Filtragem vinculada re-adicionada: só filtra quando um filtro está ativo

## 3.5.33 (2026-07-27)

### Fixes
- `getUserNames` agora inclui usuários do scanner cache (não só events DB)
- Botões refresh (↻) nos selects de usuário e dispositivo

## 3.5.32 (2026-07-27)

### Ajustes
- Dropdowns sempre mostram todos usuários/dispositivos (sem filtro vinculado)

## 3.5.31 (2026-07-27)

### Fixes
- `splitUser is not defined` no admin — função faltava
- `_xrefPending` sempre limpo mesmo em erro

## 3.5.30 (2026-07-27)

### Fixes
- WS/ph handler: `renderTimeline` sempre executado mesmo se xref falhar
- Log de erros `WS_XREF_ERR`/`PH_XREF_ERR` no debug panel

## 3.5.29 (2026-07-27)

### Features
- Filtros vinculados: selecionar usuário filtra dispositivos relacionados e vice-versa
- Cards clicáveis: clica no dispositivo → abre timeline dele, clica no usuário → abre timeline
- Botões reset (✕) para limpar cada filtro

## 3.5.28 (2026-07-27)

### UI
- Timeline simplificada: apenas período + datas
- Filtro por usuário/dispositivo via selects do cruzamento
- Xref + Gantt atualizam juntos

## 3.5.27 (2026-07-27)

### Fixes
- JS syntax: linhas órfãs duplicadas após selectAllDevs

## 3.5.26 (2026-07-27)

### UI
- Seletor de dispositivos: `<select multiple>` nativo em vez de panel custom

## 3.5.25 (2026-07-27)

### UI
- Dispositivos: chips substituídos por painel busca+checkbox
- Botão mostra contador `N/total`
- Painel com scroll para 500+ dispositivos

## 3.5.24 (2026-07-27)

### UI
- Filtros do admin reorganizados: presets + separador + datas + dispositivos
- CSS: `.tbsep`, `.btn-sm`, `.devlabel`, `.devsearch`
- Removido `tlHint` duplicado

## 3.5.23 (2026-07-27)

### Ajustes
- Label na barra: `text-overflow:ellipsis` + `title` para barras estreitas

## 3.5.22 (2026-07-27)

### Fixes
- Device offline detectado via `doc.pwr`: se dispositivo desligou, usuário mostra Offline
- Servidor envia `_pwrMap` junto com events
- Frontend usa pwrMap para sobrescrever status no user list

## 3.5.21 (2026-07-27)

### Ajustes
- Desbloqueado → Online (mesma cor verde)
- Apenas Bloqueado (laranja) e Offline (cinza) destoam

## 3.5.20 (2026-07-27)

### Ajustes
- Device: label do usuário na barra (como no admin)
- Gantt com scroll vertical: `max-height: calc(100vh - 280px)`

## 3.5.19 (2026-07-27)

### Ajustes
- Admin: barras unificadas por usuário com segmentos coloridos empilhados
- Admin: altura da linha ajustada dinamicamente por número de usuários

## 3.5.18 (2026-07-27)

### Ajustes
- Admin: removido nome de usuário de dentro das barras do Gantt (tooltip substitui)
- Admin: tooltip nas barras individuais (igual ao device)

## 3.5.17 (2026-07-27)

### Ajustes
- Coluna SESSÃO: 90px → 160px para caber nomes completos
- Removido label do usuário sobre a barra do Gantt

## 3.5.16 (2026-07-27)

### Fixes
- `esc is not defined`: função `esc()` acidentalmente removida ao adicionar `segColor()`

## 3.5.15 (2026-07-27)

### Debug
- Log detalhado em cada etapa: RG (renderGantt), GR (_renderGantt), WSE (WS error)
- Error catch com log em vez de silencioso

## 3.5.14 (2026-07-27)

### Features
- Gantt: segmentos unificados em barra contínua com cores por estado
- Tooltip no hover com: usuário, horário, estado, duração

## 3.5.13 (2026-07-27)

### Features
- Gantt com segmentos coloridos por estado: verde (Online), laranja (Bloqueado), âmbar (Desbloqueado), cinza (Offline)
- `buildSessions` agora processa `userLock`/`userUnlock` como segmentos separados

## 3.5.12 (2026-07-27)

### Fixes
- Device tab: `w` e `c` undefined no `_renderGantt` — `ReferenceError` engolia renderização

## 3.5.11 (2026-07-27)

### Fixes
- Handler duplo: pluginHandler + WebSocket addEventListener + onmessage
- Debug raw do objeto recebido

## 3.5.10 (2026-07-27)

### Debug
- Log detalhado no handler timeline

## 3.5.9 (2026-07-27)

### Fixes
- Mensagem consumida pelo MeshCentral: registrar handler em `pluginHandler.usertracer[method]`

## 3.5.8 (2026-07-27)

### Fixes
- WS listener sobrescrito pelo MeshCentral: usar `addEventListener` em vez de `onmessage`

## 3.5.7 (2026-07-27)

### Fixes
- Device tab vazia: `parent.meshserver` não alcançava iframe aninhado → `top.meshserver`

## 3.5.6 (2026-07-27)

### Fixes
- JS syntax: backslashes literais do edit tool quebravam parser do script

## 3.5.5 (2026-07-27)

### Fixes
- `gotonode`: remove prefix `node//` antes de montar URL

## 3.5.4 (2026-07-27)

### Fixes
- Navegação: `top.location.href` em vez de `parent`/`window` — evitava iframe aninhado

## 3.5.3 (2026-07-27)

### Fixes
- Navegação: `?viewmode=10&gotonode=` agora usa path root-relative (`/`)
- device.handlebars: remove query duplicada no iframe

## 3.5.2 (2026-07-24)

### Limpeza e navegação
- Removido "Ao Vivo" (auto-refresh) e zoom do Gantt
- Removido detail-panel (clique na barra agora navega para viewmode=10&gotonode)
- Removida aba "Agora" do device.handlebars (apenas Timeline)
- Clique na barra → `window.location.href='?viewmode=10&gotonode=NODEID'`
- Lock/unlock tracking completo (userLock, userUnlock, userLogout)


## 3.5.1 (2026-07-24)

### Gantt detalhado
- Clique na barra de sessão → detalhes com IP, SO, Agente, Domínio (via getNodeDetails)
- Linha "agora" clicável → heartbeat info do scanner
- Zoom por rolagem do mouse no Gantt
- Auto-refresh ao vivo com botão "Ao Vivo" (30s)
- getNodeDetails: novo serveraction que busca doc do nó no meshServer.db

## 3.5.0

### Gantt interativo
- Auto-refresh ao vivo (30s) com botão Ao Vivo
- Linha "agora" no timeline
- Clique na barra de sessão → detalhes (início, duração, eventos)
- Zoom por rolagem do mouse
- Admin: timeline multi-dispositivo + cross-reference
- Device: Gantt ao vivo + user history

## 3.4.0 (2026-07-24)

### Cross-reference tab
- Nova aba "Cruzamento": dois painéis lado a lado
- "Usuário → Dispositivos": seleciona um usuário → mostra timeline de dispositivos que ele usou
- "Dispositivo → Usuários": seleciona um dispositivo → mostra timeline de usuários que logaram nele
- `db.js`: `getUserNames()` — lista usuários únicos do histórico
- `usertracer.js`: `getUserNames` handler + `username` filter no `getTimeline`
- `checkNode`: guard rigoroso para `typeof nodeid !== 'string'`
- Guide atualizado: 12 agentes, Linux (mtype=1), cache timing, novos erros

## 3.3.1 (2026-07-24)

### UI alinhada ao MeshCentral
- Tema claro MeshCentral: fundo `#d3d9d6`, header `#003366`, painéis brancos
- Fonte Trebuchet MS; abas estilo topbar (cinza/selecionado navy)
- Usuários: lista tabela (padrão) + cards; botões nativos MeshCentral
- Timeline Gantt mantida, cores compatíveis com UI clara


## 3.3.0 (2026-07-24)

### UI redesign
- Admin panel dark theme: cards de usuários ativos, stats, busca
- Timeline Gantt profissional: eixo de tempo, sessões login→logout coloridas por usuário
- Filtros: Hoje / 7d / 30d / mês + range custom + chips multi-dispositivo
- Device tab alinhada (Agora + Timeline com range)
- Tooltip de sessão com duração; barra tracejada = sessão aberta

## 3.2.0 (2026-07-23)

### Timeline persistente
- `db.js` — novo módulo de banco NeDB com fallback chain (`@seald-io/nedb` → `@yetzt/nedb` → `nedb`)
- Scanner periódico (30s) varre todos os agentes e detecta login/logout por diff de `doc.users`
- `hook_agentCoreIsStable` + `hook_processAgentData` disparam verificação imediata
- Eventos armazenados em `plugin-usertracer-events.db` (persiste restart)
- Admin panel: abas "Usuários Ativos" + "Timeline"
- Device tab: abas "Agora" + "Histórico"
- Server-side usa `db.js` (plugin DB) + `meshServer.db` (MeshCentral DB)

## 3.1.0 (2026-07-23)

### Melhorias
- Plugin funcional: exibe usuários ativos de cada dispositivo via `db.Get(nodeId)` → `doc.users`
- Debug completo: collapsible panel no frontend + console.log no servidor
- Listener WebSocket no `ms.socket.onmessage` (RAW) — captura resposta antes do framework
- Guia de desenvolvimento expandido (MESHCENTRAL-PLUGIN-GUIDE.md) com estruturas de dados, I/O, fluxos

## 3.0.3 (2026-07-23)

### Debug
- Adicionado dump de chaves das fontes de dados (parent.agents, wsagents) para localizar onde estão os usuários ativos

## 3.0.2 (2026-07-23)

### Ajustes
- Código simplificado e limpo
- Plugin funcional: admin panel com tabela de dispositivos + usuários ativos

## 3.0.1 (2026-07-23)

### Simplificação máxima
- Server-side reduzido de 200+ linhas para **85 linhas** — só lê o usuário atual dos agentes
- `db.js` removido — sem banco, sem NeDB, sem dependências externas
- `modules_meshcore/usertracer.js` removido — sem código no agente
- Admin panel: tabela simples com dispositivo + usuário + domínio
- Device tab: card com usuário ativo da máquina
- Sem `hook_agentCoreIsStable`, sem `hook_processAgentData`, sem `server_startup`
- Basta reinstalar que funciona imediatamente

## 3.0.0 (2026-07-23)

### Mudança fundamental de abordagem
- **Removido** `query user` polling no agente (lento, complexo, falho)
- **Agora** usa dados de usuário que o próprio MeshCentral já coleta dos agentes (`device.users`, `device.lusers`)
- Server-side periodic scan (30s) detecta login/logout comparando estados anteriores
- `hook_agentCoreIsStable` + `hook_processAgentData` disparam verificação imediata quando agente conecta ou envia dados
- Agent-side module reduzido a placeholder mínimo
- Dados históricos armazenados em NeDB com nodeid, username, domain, displayUser, eventType

### Por que essa mudança
O MeshCentral já exibe o usuário atual de cada máquina na lista de dispositivos (ex: `BKSSERVICES\Fabiana.Gomes`).
Esse dado é enviado pelo agente e armazenado em `device.users`/`device.lusers` automaticamente.
Não precisamos rodar `query user` no agente — o MeshCentral já faz isso por nós.

### Benefits
- Imediato: dados disponíveis assim que o agente conecta
- Confiável: usa a mesma fonte de dados que a própria UI do MeshCentral
- Zero overhead no agente
- Histórico preciso de login/logout por comparação de estados

## 2.0.3 (2026-07-23)

### Fixes
- `db.js`: `setAutocompactionInterval` agora chamado diretamente no Datastore (não em `persistence.`) — elimina deprecation warning do `@seald-io/nedb`

### Notes
- Servidor inicia sem erros, agentes conectam, plugin funcional

## 2.0.2 (2026-07-23)

### Fixes
- `db.js`: removed duplicate function block (30 linhas) que causava `SyntaxError: Unexpected token '}'` no carregamento
- Lint em todos os arquivos: trailing whitespace removido, sintaxe validada

### Notes
- Delete a pasta manualmente como Administrador e reinstale pela URL do `config.json`

## 2.0.1 (2026-07-23)

### Fixes
- `db.js`: cadeia de fallback NeDB (`@seald-io/nedb` → `@yetzt/nedb` → `nedb`) seguindo padrão ScriptTask — resolve `Cannot find module 'nedb'` no MeshCentral v1.2.4
- Adicionado `module.paths.push()` com `meshserver.parentpath` para resolução de módulos NeDB
- Adicionado debug server-side com `obj.debug()` em todos os pontos críticos (EventLog/RegEdit pattern)
- Adicionado debug agent-side com `dbg()` + `debug_flag` + `setDebug` (EventLog/ScriptTask pattern)
- Removido `.gitignore` do repositório para evitar `EPERM` na extração do ZIP

### Agora é necessário deletar manualmente a pasta do plugin
O `.gitignore` e `changelog.md` antigos estão com permissão travada no disco. Rode como **Administrador**:
```powershell
takeown /f "C:\Program Files\Open Source\MeshCentral\meshcentral-data\plugins\usertracer" /r /d y 2>$null; icacls "C:\Program Files\Open Source\MeshCentral\meshcentral-data\plugins\usertracer" /grant Administradores:F /t /q 2>$null; rmdir -recurse -force "C:\Program Files\Open Source\MeshCentral\meshcentral-data\plugins\usertracer"
```
Depois reinstale pela URL do `config.json`.

## 2.0.0 (2026-07-23)

### Rewrite completo
- Código reescrito do zero seguindo padrões validados dos 12 plugins analisados (ScriptTask, EventLog, RegEdit, RoutePlus, FileDistribution, WorkFromHome, DevTools, Sample, PluginHookScheduler, Agentname2Servername, PrinterControl, PluginHookExample)
- Database module (db.js) isolado seguindo padrão EventLog/ScriptTask com suporte NeDB + MongoDB
- Server-side simplificado: sem `registerPermissions`, sem debug file, sem try-catch aninhados
- Agent-side seguindo padrão ScriptTask: `consoleaction()` + `mesh.SendCommand()` com `nodeid` incluso
- Views sem CDN, sem vis.js, sem dependências externas — CSP-compliant
- Frontend usa `parent.meshserver.send()` (padrão DevTools/PrinterControl/EventLog)
- Handlers registrados em `pluginHandler.usertracer[method]` (padrão MeshCentral)

### Remoções
- `registerPermissions()` removido — compatível com versões antigas do MeshCentral (como DevTools e EventLog)
- Todo código de debug (`dbgLog`, `console.log('PLUGIN:')`, arquivo `C:\usertracer-debug.log`) removido
- Vis.js e CDN removidos
- `pnetMsg` removido (só `meshserver.send()`)

### Compatibilidade
- `>=1.0.0` — testado nos mesmos padrões dos plugins da comunidade

## 1.0.8 (2026-07-23)

### Debug
- Added file-based logging to `C:\usertracer-debug.log` (writes at every step: `require()`, constructor, `server_startup`, `handleAdminReq`, errors)
- All `console.log('PLUGIN:')` replaced with `dbgLog()` that writes to file AND console
- Added user/siteadmin detail logging in `handleAdminReq` to diagnose 401
- Fixed duplicate `var obj = {}` in constructor

### Notes
- Delete and reinstall; check `C:\usertracer-debug.log` after reinstalling

## 1.0.7 (2026-07-23)

### Debug
- Added `console.log('PLUGIN: ...')` at module load, constructor, `server_startup`, DB init, and permission registration
- Wrapped `initDB()` and `registerPermissions()` in try-catch with error logging
- Logs appear in **MeshCentral server terminal** (not browser DevTools) — needed because the plugin JS `require()` failure is server-side

### Notes
- Delete and reinstall; logs will show exactly where plugin loading stops

## 1.0.6 (2026-07-23)

### Fixes
- Changed `view_admin` permission default from `denied` to `allowed` — MeshCentral plugin handler was blocking admin panel access with 401 before reaching our handler
- Restored proper `handleAdminReq` implementation after debug cycle

### Notes
- **Must delete and reinstall the plugin** — "Reload" does not refresh cached plugin JS on disk. Remove via dropdown, then re-download from the same `configUrl`

## 1.0.5 (2026-07-23)

### Fixes
- Agent `SendCommand` now includes `nodeid` (from `mesh.info._id`) so server can identify the source device
- `serveraction` derives `nodeid` from agent WebSocket connection (`myparent.nodeid`) as fallback
- Events no longer discarded — "sessionEvents missing nodeid" fixed

### Notes
- Server restart required; agents must reconnect to receive updated `modules_meshcore`

## 1.0.4 (2026-07-23)

### Fixes
- Removed vis-network CDN dependency (blocked by MeshCentral CSP)
- Replaced vis.js network graph with inline relationship matrix (HTML/CSS/JS puro, zero dependências externas)

### Notes
- All content now served from `'self'` — fully CSP-compliant

## 1.0.3 (2026-07-23)

### Fixes
- All views converted to `.handlebars`; `res.render()` works natively with MeshCentral's Express renderWrapper
- Communication migrated from `pnetMsg` to standard `parent.meshserver.send({ action: 'plugin', ... })`
- Device tab and admin panel now load without "Failed to lookup view" errors

### Notes
- Compatible with all MeshCentral versions >=1.0.0
- Remove old plugin before reinstalling to clear cached `.ejs` files

## 1.0.2 (2026-07-23)

### Fixes
- Converted templates from `.ejs` to `.handlebars` — MeshCentral's Express `renderWrapper` resolves Handlebars correctly, fixing "Failed to lookup view" error
- Reverted `handleAdminReq` to standard `res.render('admin', {})` and `res.render('device', {})` per EventLog pattern
- Frontend communication now uses `parent.meshserver.send()` (MeshCentral native) instead of `pnetMsg`
- Views use `{{var}}` Handlebars syntax for server-injected variables (`nodeid`, `nodeName`)

### Notes
- Upgrade by reinstalling from the same `configUrl`; remove old plugin first to clear cached `.ejs` files

## 1.0.1 (2026-07-23)

### Fixes
- `res.render()` now uses relative view names instead of absolute paths, fixing "Failed to lookup view" error on plugin install
- Removed unused `obj.VIEWS` variable

### Notes
- No breaking changes; upgrade by reinstalling from the same `configUrl`

## 1.0.0 (2026-07-23)

### Features
- Agent-side Windows user session detection via `query user` polling (30s interval)
- Session delta engine — detects login, logout, RDP disconnect, and RDP reconnect events without false positives
- Multi-session support: tracks all console + RDP/TS sessions simultaneously
- NeDB persistent storage for events and snapshots (`plugin-usertracer-events.db`)
- Server hooks: `hook_agentCoreIsStable` auto-starts polling on agent connect
- Permission registration: `view_audit` (default allowed), `view_admin` (default denied)
- WebSocket communication with `action: plugin` format and session-targeted responses

### Admin Panel
- **Lista** — tab with filterable event table (by type, user, device)
- **Por Usuário** — card grid showing all devices each user has accessed, with counts and timestamps
- **Por Dispositivo** — card grid showing all users on each device
- **Timeline** — chronological visual flow of all events
- **Grafo** — interactive vis.js network graph of user-device relationships

### Device Tab
- Summary counters (logins, logouts, distinct users, disconnections)
- Per-device event table with type/state filters
- "User Tracer" tab registered on Windows devices only

### Fixes
- RDP disconnect/reconnect no longer fires false login/logout (Disc sessions kept in state)
- `parseQueryUserOutput` returns parsed sessions instead of empty array
- Device tab `render()` writes to `tbody.innerHTML` instead of hanging on "Carregando..."
- View names use relative form (`'admin'` not absolute path) per MeshCentral plugin convention
- Repository URLs corrected from `misael.filho` to `jukmisael`

### Notes
- MeshCentral compat: `>=1.0.0`
- Agent-side runs on Windows only; silently no-ops on other platforms
- Default poll interval: 30 seconds
