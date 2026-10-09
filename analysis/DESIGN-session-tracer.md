# DESIGN — Session Tracer: coleta orientada a evento com store-and-forward

> Status: proposta (v4.0). Substitui o scanner 30s como fonte primária; scanner vira fallback.
> Verificado contra upstream em 2026-10-09: `pluginHandler.js:155` (injeção modules_meshcore),
> `meshagent.js:1591` (`case 'plugin'` agent→server), `meshcore.js:858` (eventos user-sessions).

---

## 1. Visão geral

```
NOTEBOOK (MeshAgent / meshcore)                SERVIDOR (MeshCentral / plugin usertracer)
┌────────────────────────────────┐             ┌─────────────────────────────────────┐
│ user-sessions (já existe)      │             │ serveraction() — case from:'agent'  │
│   'locked'/'unlocked'/'changed'│             │   1. valida schema                  │
│        │                       │             │   2. dedup por event.id (idempotente)│
│        ▼                       │   batch     │   3. grava no banco (db.js)         │
│ session-tracer.js              │ ──────────► │   4. envia ACK com os ids           │
│   1. WRITE-AHEAD no journal    │ ◄────────── │                                     │
│   2. envia live + batches      │    ack      └─────────────────────────────────────┘
│   3. remove do journal só APÓS │
│      ack                       │
└────────────────────────────────┘
        │
        ▼
journal JSONL no disco local (sobrevive a reboot, sem internet, tunnel off)
```

Princípios:
1. **Persistir antes de transmitir** (write-ahead): nenhum evento depende da conexão.
2. **At-least-once + dedup**: rede pode falhar depois do servidor gravar mas antes do ack;
   o agente reenvia, o servidor descarta repetidos pelo `id`.
3. **Ack explícito**: o evento só sai do journal quando o servidor confirmou a gravação.
4. **Nenhuma heurística no caminho do evento**: timestamp é o do SO, na ocorrência.

---

## 2. Formato do evento (schema v1)

```json
{
  "id": "A7B3-<bootId>-<seq>",     // único global; base do dedup
  "schema": 1,
  "type": "session.lock",          // session.logon | session.logoff | session.lock
                                   // | session.unlock | session.idle | device.heartbeat
  "ts": 1728483600123,             // clock do DISPOSITIVO (ocorrência real)
  "sid": 3,                        // session id do SO (WTS tsid / logind)
  "user": "BKS\\afarias",
  "seq": 4182,                     // contador monotônico por boot (ordenação)
  "bootId": "A7B3"                 // id do boot (ver §5 — mudança de relógio)
}
```

Envelope da mensagem (canal já existente, `meshagent.js:1591`):

```json
{ "action": "plugin", "plugin": "usertracer", "from": "agent",
  "cmd": "events", "batch": [ {evento}, {evento}, ... ] }
```

ACK do servidor (mesmo canal, direção inversa — o plugin escreve no `obj` do agente):

```json
{ "action": "plugin", "plugin": "usertracer", "from": "server",
  "cmd": "ack", "ids": ["A7B3-...", "..."] }
```

Regras:
- Batch ≤ 100 eventos ou ≤ 64 KB (limite pragmático de comando de agente).
- `device.heartbeat` a cada 6h: prova "agente vivo e coletando" mesmo sem eventos,
  e carrega `{journalSize, oldestTs, moduleVer}` para observabilidade.

---

## 3. Journal (a "tabela" no notebook)

Arquivo JSONL append-only, no diretório de dados do agente:

```
{"h":1,"schema":1,"nextSeq":4183,"bootId":"A7B3"}      ← linha-cabeçalho (reescrita em updates)
{"id":"A7B3-A7B3-4180","type":"session.lock", ...}
{"id":"A7B3-A7B3-4181","type":"session.unlock", ...}
```

Operação:
- **Write-ahead**: todo evento é appendado ANTES de qualquer tentativa de envio
  (também os "live", no momento em que acontecem).
- **Ack = remoção**: após ack, as linhas correspondentes são marcadas e o arquivo
  é reescrito (compactação) — apenas com pendências restantes.
- **Cap de segurança**: 10.000 eventos ou 5 MB (o que vier primeiro). Ao estourar,
  descarta os MAIS ANTIGOS e appenda um marcador
  `{"type":"journal.truncated","dropped":N,"olderThanTs":...}` — o servidor registra
  a lacuna na timeline em vez de fingir que ela não existe.
- **Crash-safety**: JSONL append é tolerante a queda de energia; na carga, linhas
  corrompidas (última parcial) são ignoradas.

Fluxo de envio:
- **Live**: evento acontece → journal → tenta enviar imediatamente (batch de 1)
  se o túnel com o servidor está aberto.
- **Dreno**: no evento de conexão do MeshAgent (`MeshAgent.on('connected')`) e
  periodicamente (60s), envia o journal em batches; só remove após ack.
  Se a conexão cair no meio, nada é perdido: segue no journal.
- **Sem internet por dias**: journal cresce até o cap; heartbeat registra a
  lacuna. Ao voltar, drena em segundo plano (batch a batch, sem saturar o túnel).

---

## 4. Servidor — `serveraction` (case `from:'agent'`)

1. **Validação**: `schema === 1`, `type` conhecido, `ts` numérico, batch ≤ limites.
2. **Dedup idempotente**: `id` já existe no banco (índice único) → conta como
   processado e entra no ack normalmente (o reenvio é esperado, não é erro).
3. **Persistência** via `db.js` existente, com campos extras:
   `src: 'agent'`, `srvTs: <receipt time>`.
4. **ACK**: ids processados de volta pelo canal do agente.
5. **Detecção de skew**: se `|ts − srvTs| > 10 min`, grava `clockSkew: true`
   (a UI exibe "horário do dispositivo" com aviso; não corrige silenciosamente).

### Convivência com o scanner (fallback)

- O módulo anuncia presença no primeiro contato: `cmd: 'hello', moduleVer, caps`.
- Nós **com** módulo ativo: scanner não gera evento (só alimenta `devicePower`).
- Nós **sem** módulo (core antigo ainda propagando, SO sem suporte): scanner
  continua como hoje, e os eventos são gravados com `src: 'scan'`.
- A timeline marca a origem: `agent` (preciso, ±0s) vs `scan` (±30s) — o usuário
  vê a confiança de cada ponto do Gantt.
- Transição: quando o primeiro evento `src:'agent'` de um nó chega, o servidor
  grava `agentSince: <ts>`; relatos `scan` anteriores mantêm valor histórico.

---

## 5. Casos difíceis, deliberadamente

| Caso | Tratamento |
|---|---|
| **Notebook sem internet (dias/semanas)** | journal em disco; drena no retorno; cap com marcador de lacuna |
| **Queda de energia / crash** | JSONL append-only; última linha parcial é descartada na carga; seq do cabeçalho evita reuso |
| **Relógio mudou (NTP, viagem, bateria)** | ordem canônica = `seq` dentro do `bootId`; `ts` é exibição; skew sinalizado, nunca corrigido em silêncio |
| **Servidor recebeu mas o ack se perdeu** | reenvio no reconnect; dedup por `id` no servidor (at-least-once tolerado) |
| **Servidor reinstalado / banco zerado** | agente mantém journal; `hello` pode pedir `resync: true` e reenviar tudo que ainda não expirou do cap |
| **Múltiplas sessões (RDP + console)** | eventos carregam `sid`; servidor agrupa por `sid` na timeline (hoje o diff de snapshot perde essa distinção) |
| **Idle** | sem evento nativo confiável: amostragem — timer no módulo compara `GetLastInputInfo` (win) / `IdleHint` (logind) e emite `session.idle {ts, state:'start'|'stop'}` quando a transição é detectada entre amostras de 60s; precisão ±60s, documentada |
| **Agente desinstalado com journal cheio** | perda aceita e limitada pelo cap (o dado nunca esteve em lugar mais seguro que o disco local) |

---

## 6. Interfaces de cada peça

### `modules_meshcore/session-tracer.js` (agente) — responsabilidades
- assinar `user-sessions` (`meshcore.js:858` mostra o padrão);
- journal (append/compact/cap);
- `hello` + dreno com ack + heartbeat;
- amostragem de idle;
- NÃO toca no banco, NÃO conhece a UI.

### `usertracer.js` (servidor) — acréscimos
- `serveraction`: branch `command.from === 'agent'` (validar → dedup → gravar → ack);
- branch `from === 'server'` é enviado de volta por ele mesmo (ack/skew);
- scanner vira fallback explícito (`src:'scan'`);
- `getTimeline` expõe `src`, `clockSkew`, lacunas de `journal.truncated`.

### Frontend
- sem mudança de canal; novos campos opcionais na timeline
  (badge "preciso" vs "amostrado"; aviso de lacuna).

---

## 6.5 Modelo de responsabilidades: push de eventos + pull on-demand (sem scanner)

Com o canal bidirecional verificado (`meshagent.js:1591` agente→servidor;
`meshcore.js:2066` servidor→agente via `consoleaction`), o servidor **deixa de ter
qualquer papel ativo de coleta**:

### a) Histórico = PUSH (agente inicia, sempre)
```
evento no SO → journal → push {cmd:'events', batch:[...]} → ack
```
O servidor nunca "pergunta o que aconteceu". Ele é consumidor reativo + gravador.
O scanner de 30s (`scanNow`/`checkNode`/`userCache`) **deixa de existir** como
fonte de eventos; `devicePower` TTL permanece só como enriquecimento de UI
(off/on barato, já mantido pelo próprio MeshCentral via `pwr`).

### b) Estado atual = PULL on-demand (só quando alguém olha)
Quando um admin abre o device tab (`onDeviceRefreshEnd`) ou o painel admin:
```
serveraction (do browser) → detecta nodeid alvo →
  obj.send(JSON.stringify({ action:'plugin', plugin:'usertracer',
                            cmd:'query-state', reqId: R }))   → agente
agente: consoleaction(data, rights, sessionid, conn) responde
  { action:'plugin', plugin:'usertracer', cmd:'state', reqId: R,
    sessions:[{sid, user, state:'active'|'locked'|'idle', idleSec}], uptime }
→ server responde ao browser do admin (mesma conexão WS do usuário)
```
- `reqId` criado pelo plugin (o protocolo não tem correlação — nós adicionamos
  no próprio envelope do plugin, sem tocar no core).
- Agente offline → resposta imediata de `offline: true` + último estado conhecido
  (banco) + power state. Ninguém fica esperando.
- Custo zero quando ninguém está olhando — não há polling nenhum.

### c) Configuração = PUSH sob demanda (servidor → agente)
No `hello` e quando o admin muda settings: `{cmd:'config', idleSampleSec,
enabled, caps}`. O agente confirma com ack na mesma mecânica do journal.

### Resultado
| Necessidade | Mecanismo | Quem inicia | Frequência |
|---|---|---|---|
| Histórico (lock/unlock/logon/logoff) | evento + journal | agente | na ocorrência |
| "Quem está usando agora?" | query on-demand | servidor, só sob demanda de UI | quando aberto |
| Idle | amostragem local, evento emitido na transição | agente | 60s interno, 0 rede |
| Presença do agente | heartbeat no journal | agente | 6h |

Princípio: **o agente é a fonte de tudo; o servidor é burro e reativo.**
Nenhum interval, nenhum scan, nenhuma heurística de diff em nenhum lado.

---

## 7. Por que não soluções alternativas

- **Fila só em memória** (sem journal): perde tudo em reboot — é o caso exato
  do notebook que ficou offline e reiniciou.
- **Confiar no buffer do WebSocket**: o túnel do agente não garante fila
  persistente de `SendCommand` enquanto desconectado.
- **QoS/retenção no servidor**: não resolve; o problema é o trecho sem rede.
- **MeshCentral já tem algo assim?** Não para isso: `lastconnect` é 1 registro
  por nó (`_id:'lc'+nodeid`, sobrescrito) e `storePowerEvent` só guarda energia.
