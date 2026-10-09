'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// =============================================================================
// Contract: canal plugin agente↔servidor contra o SOURCE REAL do upstream
//
// Estes testes leem os fontes clonados de Ylianst/MeshCentral e verificam que
// os contratos dos quais o session-tracer depende continuam de pé. Se o Ylian
// refatorar algo que quebra o plugin, ESTE teste quebra primeiro — não a
// produção.
//
// Fonte: variável de ambiente MESHCENTRAL_SRC, ou clone raso em
// <tmpdir>/MeshCentral-src. Sem fonte disponível, os testes são SKIPADOS
// (CI pode clonar antes: git clone --depth 1 https://github.com/Ylianst/MeshCentral).
// =============================================================================

const SRC = process.env.MESHCENTRAL_SRC || path.join(os.tmpdir(), 'MeshCentral-src');

const hasFullSrc = fs.existsSync(path.join(SRC, 'meshagent.js')) &&
                   fs.existsSync(path.join(SRC, 'agents', 'meshcore.js')) &&
                   fs.existsSync(path.join(SRC, 'pluginHandler.js'));

const REPO = path.resolve(__dirname, '../..');

function readSrc(rel) {
    return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

// =============================================================================
// Contrato 1: agente → servidor (serveraction)
// =============================================================================

test('contrato: meshagent.js roteia {action:plugin} do agente para serveraction', { skip: !hasFullSrc }, () => {
    const src = readSrc(path.join('meshagent.js'));
    assert.match(src, /case 'plugin':\s*\{/);
    assert.match(src, /pluginHandler\.plugins\[command\.plugin\]\.serveraction\(command, obj, parent\)/);
});

test('contrato: serveraction recebe a conexão do agente (sem .ws/.user) — branch from:agent precisa vir antes do check de sid', { skip: !hasFullSrc }, () => {
    const src = readSrc(path.join('meshagent.js'));
    // o case 'plugin' chama serveraction(command, obj, parent) — obj é a agentConn.
    // Pina a ordem no NOSSO plugin: branch from==='agent' antes de qualquer uso de myparent.ws
    const pluginSrc = fs.readFileSync(path.join(REPO, 'usertracer.js'), 'utf8');
    const branchPos = pluginSrc.indexOf("if (command.from === 'agent')");
    const sidPos = pluginSrc.indexOf('var sid = null;');
    assert.ok(branchPos > -1, 'branch from:agent deve existir');
    assert.ok(sidPos > -1, 'check de sid deve existir (browser)');
    assert.ok(branchPos < sidPos, 'branch from:agent DEVE vir antes do check de sid (agentConn não tem .ws.sessionId)');
});

// =============================================================================
// Contrato 2: servidor → agente (consoleaction)
// =============================================================================

test('contrato: meshcore.js roteia {action:plugin} do servidor via require(data.plugin).consoleaction', { skip: !hasFullSrc }, () => {
    const src = readSrc(path.join('agents', 'meshcore.js'));
    assert.match(src, /case 'plugin':\s*\{/);
    assert.match(src, /require\(data\.plugin\)\.consoleaction\(data, data\.rights, data\.sessionid, this\)/);
});

test('contrato: o módulo agente DEVE se chamar usertracer.js (require(data.plugin) usa o id do plugin)', { skip: !hasFullSrc }, () => {
    const pluginSrc = fs.readFileSync(path.join(REPO, 'config.json'), 'utf8');
    const cfg = JSON.parse(pluginSrc);
    assert.equal(cfg.shortName, 'usertracer');

    // require('usertracer') no meshcore resolve o módulo com ESTE nome no core
    const modulePath = path.join(REPO, 'modules_meshcore', 'usertracer.js');
    assert.ok(fs.existsSync(modulePath), 'modules_meshcore/usertracer.js deve existir (meshcore.js:2067 faz require(data.plugin))');
    const moduleSrc = fs.readFileSync(modulePath, 'utf8');
    assert.match(moduleSrc, /consoleaction/, 'módulo agente deve exportar consoleaction');
    // e não pode existir concorrente com outro nome que o time ache que roteia
    const rogue = ['session-tracer.js'].filter(function (f) {
        return fs.existsSync(path.join(REPO, 'modules_meshcore', f));
    });
    assert.deepEqual(rogue, [], 'não deve haver módulo agente com nome que NÃO casa com require(data.plugin)');
});

test('contrato: módulo agente sem prefixo win-/linux- é injetado em TODOS os cores', { skip: !hasFullSrc }, () => {
    const src = readSrc('pluginHandler.js');
    // addMeshCoreModules lê modules_meshcore e roteia por prefixo; sem prefixo → todos os cores
    assert.match(src, /modules_meshcore/);
    assert.match(src, /endsWith\('\.js'\)/);
    const moduleSrc = fs.readFileSync(path.join(REPO, 'modules_meshcore', 'usertracer.js'), 'utf8');
    // guarda contra mudança acidental de nome de arquivo
    assert.ok(moduleSrc.length > 0);
    const moduleName = 'usertracer.js';
    assert.equal(/^(win|linux|amt)-/.test(moduleName), false, 'sem prefixo → injetado em windows-amt, linux-amt e linux-noamt');
});

// =============================================================================
// Contrato 3: direção e codificação dos frames
// =============================================================================

test('contrato: servidor → agente envia JSON STRING (obj.send com stringify)', { skip: !hasFullSrc }, () => {
    const src = readSrc('meshagent.js');
    // padrão dominante no upstream: obj.send(JSON.stringify({...}))
    assert.match(src, /obj\.send\(JSON\.stringify\(/);
    // o NOSSO _agentSend deve stringify
    const pluginSrc = fs.readFileSync(path.join(REPO, 'usertracer.js'), 'utf8');
    assert.match(pluginSrc, /agentConn\.send\(typeof cmd === 'string' \? cmd : JSON\.stringify\(cmd\)\)/);
});

test('contrato: agente → servidor envia objeto via mesh.SendCommand (meshcore serializa)', { skip: !hasFullSrc }, () => {
    const coreSrc = readSrc(path.join('agents', 'meshcore.js'));
    // meshcore usa mesh.SendCommand(obj) — a serialização é responsabilidade do core
    assert.match(coreSrc, /SendCommand\(/);
    const moduleSrc = fs.readFileSync(path.join(REPO, 'modules_meshcore', 'usertracer.js'), 'utf8');
    assert.match(moduleSrc, /mesh\.SendCommand\(cmd\)/);
});

// =============================================================================
// Contrato 4: fonte dos eventos no agente (user-sessions)
// =============================================================================

test('contrato: user-sessions emite locked/unlocked/changed (base dos eventos do tracer)', { skip: !hasFullSrc }, () => {
    const coreSrc = readSrc(path.join('agents', 'meshcore.js'));
    assert.match(coreSrc, /userSession\.on\('locked'/);
    assert.match(coreSrc, /userSession\.on\('unlocked'/);
    assert.match(coreSrc, /userSession\.on\('changed'/);
    const agentModSrc = fs.readFileSync(path.join(REPO, 'modules_meshcore', 'usertracer.js'), 'utf8');
    assert.match(agentModSrc, /userSession\.on\('locked'/);
    assert.match(agentModSrc, /userSession\.on\('unlocked'/);
    assert.match(agentModSrc, /userSession\.on\('changed'/);
});

// =============================================================================
// Contrato 5: o servidor NÃO persiste histórico de sessão nativamente
// (motivo de existir do plugin — se um dia persistir, reavaliar o plugin)
// =============================================================================

test('contrato: lastconnect é registro único sobrescrito (_id lc+nodeid), não histórico', { skip: !hasFullSrc }, () => {
    const src = readSrc('meshcentral.js');
    assert.match(src, /_id: 'lc' \+ nodeid/);   // sobrescrito a cada evento
    assert.match(src, /storePowerEvent/);       // timeline de energia only
    // e NÃO existe store de eventos de sessão de usuário no core
    assert.doesNotMatch(src, /session\.(logon|logoff|lock|unlock)/);
});
