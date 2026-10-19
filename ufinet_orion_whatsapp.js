/*
 ==============================================================================
  UFINET - INTEGRACIÓN DE ALERTAS SOLARWINDS ORION A WHATSAPP   (v2.0)
  Ubicación estándar: C:\UfinetOrionBot
  Desarrollado por: StinkyPinky
 ==============================================================================
*/
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const readline = require('readline');
const https = require('https');
const { execFileSync } = require('child_process');
const axios = require('axios');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const APP_DIR = __dirname;
const CONFIG_FILE = path.join(APP_DIR, 'ufinet_config.json');
const STATE_FILE = path.join(APP_DIR, 'ufinet_state.json');
const AUTH_DIR = path.join(APP_DIR, '.wwebjs_auth');
const LOG_DIR = path.join(APP_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'ufinet_bot.log');

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
const OUTBOX_MAX = 500;
const INSTANCE_PORT = 47831;

const DEFAULTS = {
    port: '17774',
    allowSelfSigned: true,
    caCertPath: '',
    pollIntervalSeconds: 60,
    confirmDownCycles: 1,
    confirmUpCycles: 1,
    groupThreshold: 5,
    sendDelayMs: 1500,
    orionFailAlertAfter: 3,
    monitorApplications: true,
    queryTimeoutSeconds: 20,
    waRestartMinutes: 10,
    timezone: 'America/Managua'
};

let cfg = { ...DEFAULTS };
let httpsAgent = null;

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignorar */ }
}

function rotateLogIfNeeded() {
    try {
        if (fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return;
        for (let i = LOG_KEEP - 1; i >= 1; i--) {
            const from = `${LOG_FILE}.${i}`;
            if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i + 1}`);
        }
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch (_) { /* ignorar */ }
}

function log(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    if (level === 'ERROR') console.error(line); else console.log(line);
    try {
        ensureDir(LOG_DIR);
        rotateLogIfNeeded();
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (_) { /* ignorar */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function num(value, def, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function fmtDateTime(ts) {
    const d = new Date(ts);
    try {
        return new Intl.DateTimeFormat('es-NI', {
            timeZone: cfg.timezone,
            dateStyle: 'short',
            timeStyle: 'medium'
        }).format(d);
    } catch (_) {
        return d.toLocaleString();
    }
}

function fmtDuration(ms) {
    const totalMin = Math.max(0, Math.round(ms / 60000));
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    const parts = [];
    if (days) parts.push(`${days} d`);
    if (hours) parts.push(`${hours} h`);
    if (mins || parts.length === 0) parts.push(`${mins} min`);
    return parts.join(' ');
}

function describeError(e) {
    if (e && e.response) {
        const status = e.response.status;
        let extra = '';
        const data = e.response.data;
        if (data && typeof data === 'object' && data.Message) {
            extra = ` - ${String(data.Message).slice(0, 200)}`;
        }
        if (status === 401 || status === 403) {
            return `HTTP ${status}: credenciales inválidas o sin permisos${extra}`;
        }
        return `HTTP ${status} ${e.response.statusText || ''}${extra}`.trim();
    }
    if (e && e.code) return `${e.code}: ${e.message}`;
    return (e && e.message) || String(e);
}

function normalizeHost(input) {
    return String(input || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '');
}

function normalizeTarget(input) {
    const t = String(input || '').trim();
    if (/^[\d-]+@g\.us$/.test(t)) return t;
    if (/^\d{8,15}@c\.us$/.test(t)) return t;
    const digits = t.replace(/[\s+()-]/g, '');
    if (/^\d{8,15}$/.test(digits)) return `${digits}@c.us`;
    return null;
}

function ask(rl, question, hidden = false) {
    return new Promise((resolve) => {
        rl.stdoutMuted = false;
        rl.question(question, (answer) => {
            rl.stdoutMuted = false;
            if (hidden) process.stdout.write('\n');
            resolve(String(answer).trim());
        });
        rl.stdoutMuted = hidden;
    });
}

async function askRequired(rl, label, hidden = false) {
    for (;;) {
        const value = await ask(rl, label, hidden);
        if (value) return value;
        console.log('  Este valor es obligatorio.');
    }
}

function protectConfigFile() {
    if (process.platform !== 'win32') {
        try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) { /* ignorar */ }
        return;
    }
    try {
        const args = [CONFIG_FILE];
        if (process.env.USERNAME) {
            const owner = `${process.env.USERDOMAIN || process.env.COMPUTERNAME}\\${process.env.USERNAME}`;
            args.push('/grant:r', `${owner}:(F)`);
        }
        args.push('/grant:r', '*S-1-5-18:(F)', '/grant:r', '*S-1-5-32-544:(F)', '/inheritance:r');
        execFileSync('icacls', args, { stdio: 'ignore' });
        log('INFO', 'Permisos del archivo de configuración restringidos (SYSTEM, Administradores y usuario actual).');
    } catch (e) {
        log('WARN', `No se pudieron restringir los permisos de ${CONFIG_FILE}: ${e.message}`);
    }
}

async function promptConfig() {
    if (!process.stdin.isTTY) {
        throw new Error(
            'No existe ufinet_config.json y la consola no es interactiva (¿servicio?). ' +
            'Ejecute "node ufinet_orion_whatsapp.js" manualmente una vez para configurarlo.'
        );
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = function (text) {
        if (rl.stdoutMuted) {
            if (text.length === 1 && text >= ' ') rl.output.write('*');
        } else {
            rl.output.write(text);
        }
    };

    try {
        console.log('\n==================================================================');
        console.log('   UFINET - CONFIGURACIÓN INICIAL SOLARWINDS ORION WHATSAPP');
        console.log('   Hecho por StinkyPinky');
        console.log('==================================================================\n');

        let url = '';
        while (!url) {
            url = normalizeHost(await ask(rl, 'URL de Orion (ej: monitoreo.example.com): '));
            if (!url) console.log('  Valor inválido.');
        }

        let port = '';
        for (;;) {
            port = (await ask(rl, 'Puerto API SWIS (por defecto 17774): ')) || DEFAULTS.port;
            if (/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535) break;
            console.log('  Puerto inválido.');
        }

        const username = await askRequired(rl, 'Usuario de solo lectura de Orion: ');
        const password = await askRequired(rl, 'Contraseña de Orion: ', true);

        let target = null;
        while (!target) {
            target = normalizeTarget(await ask(rl, 'Destino WhatsApp (número ej: 50588888888, o IDGrupo@g.us): '));
            if (!target) console.log('  Destino inválido. Use solo dígitos con código de país, o un ID de grupo terminado en @g.us.');
        }

        const selfSigned = (await ask(rl, '¿El certificado HTTPS de Orion es autofirmado? (S/N, por defecto S): ')).toLowerCase();

        console.log('\nModo de alertas:');
        console.log('  1) Inmediato (por defecto): avisa en el primer sondeo que detecta la caída o la recuperación.');
        console.log('  2) Con retraso: espera 2 sondeos seguidos (~1-2 min) para evitar falsas alarmas por parpadeos.');
        let mode = '';
        for (;;) {
            mode = (await ask(rl, 'Elija 1 o 2 (por defecto 1): ')) || '1';
            if (mode === '1' || mode === '2') break;
            console.log('  Opción inválida.');
        }
        const cycles = mode === '2' ? 2 : 1;

        const fileConfig = {
            url,
            port,
            username,
            password,
            target,
            allowSelfSigned: selfSigned !== 'n',
            caCertPath: DEFAULTS.caCertPath,
            pollIntervalSeconds: DEFAULTS.pollIntervalSeconds,
            confirmDownCycles: cycles,
            confirmUpCycles: cycles,
            groupThreshold: DEFAULTS.groupThreshold,
            sendDelayMs: DEFAULTS.sendDelayMs,
            orionFailAlertAfter: DEFAULTS.orionFailAlertAfter,
            monitorApplications: DEFAULTS.monitorApplications,
            queryTimeoutSeconds: DEFAULTS.queryTimeoutSeconds,
            waRestartMinutes: DEFAULTS.waRestartMinutes,
            timezone: DEFAULTS.timezone
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(fileConfig, null, 2), 'utf8');
        protectConfigFile();
        console.log(`\n[UFINET] Configuración guardada en '${CONFIG_FILE}'.\n`);
    } finally {
        rl.close();
    }
}

function readConfigFile() {
    try {
        const text = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`No se pudo leer ${CONFIG_FILE}: ${e.message}. Corríjalo o elimínelo para volver a configurar.`);
    }
}

function validateConfig(raw) {
    const c = { ...DEFAULTS, ...raw };
    if (process.env.ORION_PASSWORD) c.password = process.env.ORION_PASSWORD;

    c.url = normalizeHost(c.url);
    c.port = String(c.port || DEFAULTS.port).trim();
    const target = normalizeTarget(c.target);

    const problems = [];
    if (!c.url) problems.push('url');
    if (!/^\d{1,5}$/.test(c.port) || Number(c.port) < 1 || Number(c.port) > 65535) problems.push('port');
    if (!c.username) problems.push('username');
    if (!c.password) problems.push('password');
    if (!target) problems.push('target');
    if (problems.length) {
        throw new Error(`Configuración inválida en ${CONFIG_FILE}. Revise: ${problems.join(', ')}.`);
    }

    c.target = target;
    c.allowSelfSigned = c.allowSelfSigned !== false;
    c.monitorApplications = c.monitorApplications !== false;
    c.caCertPath = String(c.caCertPath || '').trim();
    c.timezone = String(c.timezone || DEFAULTS.timezone);
    c.pollIntervalSeconds = num(c.pollIntervalSeconds, DEFAULTS.pollIntervalSeconds, 15, 3600);
    c.confirmDownCycles = num(c.confirmDownCycles, DEFAULTS.confirmDownCycles, 1, 10);
    c.confirmUpCycles = num(c.confirmUpCycles, DEFAULTS.confirmUpCycles, 1, 10);
    c.groupThreshold = num(c.groupThreshold, DEFAULTS.groupThreshold, 1, 100);
    c.sendDelayMs = num(c.sendDelayMs, DEFAULTS.sendDelayMs, 500, 30000);
    c.orionFailAlertAfter = num(c.orionFailAlertAfter, DEFAULTS.orionFailAlertAfter, 1, 100);
    c.queryTimeoutSeconds = num(c.queryTimeoutSeconds, DEFAULTS.queryTimeoutSeconds, 5, 120);
    c.waRestartMinutes = num(c.waRestartMinutes, DEFAULTS.waRestartMinutes, 2, 1440);
    return c;
}

async function loadOrCreateConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        await promptConfig();
    } else {
        log('INFO', 'Configuración previa cargada exitosamente desde disco.');
    }
    return validateConfig(readConfigFile());
}

function buildHttpsAgent() {
    if (cfg.caCertPath) {
        log('INFO', `Validando el certificado de Orion contra el CA: ${cfg.caCertPath}`);
        return new https.Agent({ ca: fs.readFileSync(cfg.caCertPath) });
    }
    if (cfg.allowSelfSigned) {
        log('WARN', 'Validación TLS desactivada (allowSelfSigned=true). Para mayor seguridad indique "caCertPath" en la configuración.');
        return new https.Agent({ rejectUnauthorized: false });
    }
    return new https.Agent();
}

let state = { version: 1, active: {}, outbox: [], orionDown: false };

function loadState() {
    if (!fs.existsSync(STATE_FILE)) return;
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
        state = {
            version: 1,
            active: parsed && typeof parsed.active === 'object' && parsed.active ? parsed.active : {},
            outbox: Array.isArray(parsed && parsed.outbox) ? parsed.outbox : [],
            orionDown: Boolean(parsed && parsed.orionDown)
        };
        log('INFO', `Estado restaurado: ${Object.keys(state.active).length} alerta(s) activa(s), ${state.outbox.length} mensaje(s) pendiente(s).`);
    } catch (e) {
        log('WARN', `Archivo de estado corrupto (${e.message}); se inicia con estado vacío.`);
        try { fs.renameSync(STATE_FILE, `${STATE_FILE}.bak`); } catch (_) { /* ignorar */ }
    }
}

function saveState() {
    try {
        const tmp = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
        log('ERROR', `No se pudo guardar el estado: ${e.message}`);
    }
}

function enqueue(text) {
    state.outbox.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, text, attempts: 0 });
    while (state.outbox.length > OUTBOX_MAX) {
        state.outbox.shift();
        log('WARN', `Cola de mensajes llena (${OUTBOX_MAX}); se descartó el mensaje más antiguo.`);
    }
}

const FOOTER = '_UFINET Network Operations Center_';

function formatEntityMessage(kind, e) {
    let emoji;
    let statusText;
    if (kind === 'up') {
        emoji = '🟢';
        statusText = 'RECUPERADO (UP)';
    } else if (e.status === 12) {
        emoji = '🟠';
        statusText = 'UNREACHABLE (Inalcanzable)';
    } else {
        emoji = '🔴';
        statusText = 'DOWN [CRÍTICO]';
    }

    const lines = [
        `${emoji} *MONITOREO UFINET - SOLARWINDS* ${emoji}`,
        '',
        `📌 *Entidad:* ${e.name}`,
        `📂 *Tipo:* ${e.type}`
    ];
    if (e.ip) lines.push(`🌐 *IP:* ${e.ip}`);
    lines.push(`⚡ *Estado:* ${statusText}`);
    if (kind === 'up') {
        lines.push('🔍 *Detalles:* El servicio se ha restablecido satisfactoriamente.');
        lines.push(`⏱️ *Duración de la caída:* ${fmtDuration(Date.now() - e.since)}`);
        lines.push(`🕒 *Hora:* ${fmtDateTime(Date.now())}`);
    } else {
        lines.push(`🔍 *Detalles:* ${e.details || 'Sin detalles adicionales'}`);
        lines.push(`🕒 *Hora:* ${fmtDateTime(e.since)}`);
    }
    lines.push('', FOOTER);
    return lines.join('\n');
}

function formatSummaryMessage(kind, list) {
    const up = kind === 'up';
    const emoji = up ? '🟢' : '🔴';
    const title = up ? `${list.length} entidades recuperadas` : `${list.length} entidades caídas`;
    const MAX = 30;
    const lines = [
        `${emoji} *MONITOREO UFINET - SOLARWINDS* ${emoji}`,
        '',
        `📋 *${title}*`,
        ''
    ];
    for (const e of list.slice(0, MAX)) {
        const ip = e.ip ? ` (${e.ip})` : '';
        const tag = !up && e.status === 12 ? ' [Inalcanzable]' : '';
        lines.push(`• ${e.name}${ip} — ${e.type}${tag}`);
    }
    if (list.length > MAX) lines.push(`… y ${list.length - MAX} más`);
    lines.push('', `🕒 *Hora:* ${fmtDateTime(Date.now())}`, '', FOOTER);
    return lines.join('\n');
}

function enqueueEvents(list, kind) {
    if (!list.length) return;
    if (list.length > cfg.groupThreshold) {
        enqueue(formatSummaryMessage(kind, list));
    } else {
        for (const e of list) enqueue(formatEntityMessage(kind, e));
    }
}

function msgOrionDown(detail) {
    return [
        '⚠️ *MONITOREO UFINET - SOLARWINDS* ⚠️',
        '',
        `🔌 No se puede consultar la API de Orion (${cfg.orionFailAlertAfter} sondeos consecutivos fallidos).`,
        `🔍 *Detalle:* ${detail}`,
        '⚠️ Mientras tanto no se detectarán caídas ni recuperaciones.',
        `🕒 *Hora:* ${fmtDateTime(Date.now())}`,
        '',
        FOOTER
    ].join('\n');
}

function msgOrionRestored() {
    return [
        '✅ *MONITOREO UFINET - SOLARWINDS* ✅',
        '',
        '🔌 La conexión con la API de Orion se restableció. El monitoreo continúa con normalidad.',
        `🕒 *Hora:* ${fmtDateTime(Date.now())}`,
        '',
        FOOTER
    ].join('\n');
}

function buildStatusText() {
    const entries = Object.values(state.active).sort((a, b) => a.since - b.since);
    const lines = ['📊 *ESTADO ACTUAL - UFINET*', ''];
    if (state.orionDown) lines.push('⚠️ La API de Orion no está respondiendo; el estado puede estar desactualizado.', '');
    if (entries.length === 0) {
        lines.push('🟢 Sin nodos ni aplicaciones caídas.');
    } else {
        lines.push(`🔴 *${entries.length} entidad(es) con problemas:*`, '');
        for (const e of entries.slice(0, 40)) {
            const label = e.status === 12 ? 'UNREACHABLE' : 'DOWN';
            lines.push(`• ${e.name}${e.ip ? ` (${e.ip})` : ''} — ${label} desde ${fmtDateTime(e.since)} (${fmtDuration(Date.now() - e.since)})`);
        }
        if (entries.length > 40) lines.push(`… y ${entries.length - 40} más`);
    }
    if (lastPollAt) lines.push('', `🕒 Último sondeo: ${fmtDateTime(lastPollAt)}`);
    lines.push('', FOOTER);
    return lines.join('\n');
}

const NODES_QUERY_FULL = 'SELECT NodeID, Caption, IPAddress, Status, StatusDescription FROM Orion.Nodes WHERE Status = 2 OR Status = 12';
const NODES_QUERY_BASIC = 'SELECT NodeID, Caption, Status, StatusDescription FROM Orion.Nodes WHERE Status = 2 OR Status = 12';
const APPS_QUERY = 'SELECT ApplicationID, Name, Node.Caption as NodeName, Status FROM Orion.APM.Application WHERE Status = 2';
let nodesQuery = NODES_QUERY_FULL;

async function queryOrionSWIS(swql) {
    const endpoint = `https://${cfg.url}:${cfg.port}/SolarWinds/InformationService/v3/Json/Query`;
    const response = await axios.get(endpoint, {
        params: { query: swql },
        auth: { username: cfg.username, password: cfg.password },
        headers: { Accept: 'application/json' },
        httpsAgent,
        timeout: cfg.queryTimeoutSeconds * 1000
    });
    if (!response.data || !Array.isArray(response.data.results)) {
        throw new Error('Respuesta inesperada de la API SWIS (sin "results").');
    }
    return response.data.results;
}

async function fetchNodes() {
    try {
        return await queryOrionSWIS(nodesQuery);
    } catch (e) {
        if (nodesQuery === NODES_QUERY_FULL && e.response && e.response.status === 400) {
            log('WARN', 'Orion rechazó la consulta con IPAddress (HTTP 400); se usará la consulta básica.');
            nodesQuery = NODES_QUERY_BASIC;
            return queryOrionSWIS(nodesQuery);
        }
        throw e;
    }
}

async function safeQuery(fn) {
    try {
        return { rows: await fn() };
    } catch (e) {
        return { error: describeError(e) };
    }
}

function mapNodes(rows) {
    return rows.map((n) => ({
        key: `node_${n.NodeID}`,
        kind: 'node',
        name: n.Caption || `NodeID ${n.NodeID}`,
        type: 'Nodo de Red',
        status: Number(n.Status),
        ip: n.IPAddress || n.IP_Address || '',
        details: n.StatusDescription || ''
    }));
}

function mapApps(rows) {
    return rows.map((a) => ({
        key: `app_${a.ApplicationID}`,
        kind: 'app',
        name: `${a.NodeName || 'N/A'} > ${a.Name}`,
        type: 'Aplicación (SAM)',
        status: Number(a.Status),
        ip: '',
        details: 'Servicio o componente crítico caído'
    }));
}

const pendingDown = new Map();
const upCounts = new Map();
let consecutiveFailures = 0;
let appsQueryFailing = false;
let lastPollAt = null;

function reconcile(kind, entities) {
    const prefix = `${kind}_`;
    const downNow = new Map(entities.map((e) => [e.key, e]));
    const newDown = [];
    const recovered = [];

    for (const [key, e] of downNow) {
        upCounts.delete(key);
        const active = state.active[key];
        if (active) {
            active.status = e.status;
            active.details = e.details;
            if (e.ip) active.ip = e.ip;
            continue;
        }
        const prev = pendingDown.get(key);
        const count = (prev ? prev.count : 0) + 1;
        const firstSeen = prev ? prev.firstSeen : Date.now();
        if (count >= cfg.confirmDownCycles) {
            pendingDown.delete(key);
            const entry = { ...e, since: firstSeen };
            state.active[key] = entry;
            newDown.push(entry);
        } else {
            pendingDown.set(key, { count, firstSeen });
        }
    }

    for (const key of [...pendingDown.keys()]) {
        if (key.startsWith(prefix) && !downNow.has(key)) pendingDown.delete(key);
    }

    for (const key of Object.keys(state.active)) {
        if (!key.startsWith(prefix) || downNow.has(key)) continue;
        const count = (upCounts.get(key) || 0) + 1;
        if (count >= cfg.confirmUpCycles) {
            upCounts.delete(key);
            recovered.push(state.active[key]);
            delete state.active[key];
        } else {
            upCounts.set(key, count);
        }
    }

    return { newDown, recovered };
}

async function pollOnce() {
    log('INFO', 'Verificando nodos y aplicaciones en Orion...');

    const [nodesRes, appsRes] = await Promise.all([
        safeQuery(fetchNodes),
        cfg.monitorApplications ? safeQuery(() => queryOrionSWIS(APPS_QUERY)) : Promise.resolve(null)
    ]);
    lastPollAt = Date.now();

    if (nodesRes.error) {
        consecutiveFailures++;
        log('ERROR', `Fallo al consultar nodos en Orion (intento ${consecutiveFailures}): ${nodesRes.error}`);
        if (consecutiveFailures >= cfg.orionFailAlertAfter && !state.orionDown) {
            state.orionDown = true;
            enqueue(msgOrionDown(nodesRes.error));
        }
        saveState();
        return;
    }
    consecutiveFailures = 0;
    if (state.orionDown) {
        state.orionDown = false;
        enqueue(msgOrionRestored());
        log('INFO', 'Conexión con Orion restablecida.');
    }

    const nodeEvents = reconcile('node', mapNodes(nodesRes.rows));
    enqueueEvents(nodeEvents.newDown, 'down');
    enqueueEvents(nodeEvents.recovered, 'up');

    let appEvents = { newDown: [], recovered: [] };
    if (!cfg.monitorApplications) {
        for (const key of Object.keys(state.active)) {
            if (key.startsWith('app_')) delete state.active[key];
        }
    } else if (appsRes && appsRes.error) {
        if (!appsQueryFailing) {
            appsQueryFailing = true;
            log('WARN', `Falla la consulta de aplicaciones (${appsRes.error}). Si no usa SAM/APM, ponga "monitorApplications": false en la configuración.`);
        }
    } else if (appsRes) {
        if (appsQueryFailing) {
            appsQueryFailing = false;
            log('INFO', 'La consulta de aplicaciones volvió a funcionar.');
        }
        appEvents = reconcile('app', mapApps(appsRes.rows));
        enqueueEvents(appEvents.newDown, 'down');
        enqueueEvents(appEvents.recovered, 'up');
    }

    saveState();

    const newDownCount = nodeEvents.newDown.length + appEvents.newDown.length;
    const recoveredCount = nodeEvents.recovered.length + appEvents.recovered.length;
    log('INFO', `Sondeo completado: ${Object.keys(state.active).length} activa(s), ${newDownCount} nueva(s) caída(s), ${recoveredCount} recuperación(es), ${state.outbox.length} mensaje(s) en cola.`);
}

async function pollLoop() {
    while (!shuttingDown) {
        const started = Date.now();
        try {
            await pollOnce();
        } catch (e) {
            log('ERROR', `Error inesperado en el ciclo de sondeo: ${e && e.stack ? e.stack : e}`);
        }
        const wait = Math.max(1000, cfg.pollIntervalSeconds * 1000 - (Date.now() - started));
        await sleep(wait);
    }
}

let client = null;
let waReady = false;
let everReady = false;
let notReadySince = Date.now();
let restartScheduled = false;
let shuttingDown = false;
let instanceServer = null;

function setReady(value) {
    if (value === waReady) return;
    waReady = value;
    if (value) {
        everReady = true;
        notReadySince = null;
    } else {
        notReadySince = Date.now();
    }
}

function cleanupBrowserLocks() {
    const sessionDir = path.join(AUTH_DIR, 'session');
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
        try { fs.rmSync(path.join(sessionDir, f), { force: true }); } catch (_) { /* ignorar */ }
    }
}


function killOrphanBrowsers() {
    if (process.platform !== 'win32') return;
    try {
        const needle = AUTH_DIR.replace(/'/g, "''");
        const ps =
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|chromium' -and $_.CommandLine -like '*" +
            needle +
            "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 20000 });
    } catch (_) { /* ignorar */ }
}

async function destroyClient() {
    if (!client) return;
    const old = client;
    client = null;
    setReady(false);
    try { await Promise.race([old.destroy(), sleep(15000)]); } catch (_) { /* ignorar */ }
}

function scheduleClientRestart(reason) {
    if (restartScheduled || shuttingDown) return;
    restartScheduled = true;
    log('WARN', `Se reiniciará el cliente de WhatsApp en 30 s (${reason}).`);
    setTimeout(async () => {
        try {
            await destroyClient();
            killOrphanBrowsers();
            await startClient();
        } finally {
            restartScheduled = false;
        }
    }, 30000);
}

function handleMessage(msg) {
    (async () => {
        try {
            if (msg.from !== cfg.target) return;
            const body = String(msg.body || '').trim().toLowerCase();
            if (body === '!estado' || body === '!status') {
                await msg.reply(buildStatusText());
            } else if (body === '!ayuda' || body === '!help') {
                await msg.reply('Comandos disponibles:\n• *!estado* — lista las entidades caídas ahora mismo');
            }
        } catch (e) {
            log('WARN', `No se pudo responder un comando: ${e.message}`);
        }
    })();
}

async function startClient() {
    cleanupBrowserLocks();
    const c = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        }
    });
    client = c;

    c.on('qr', (qr) => {
        if (process.stdout.isTTY) {
            log('INFO', 'Escanee el código QR con el número emisor de WhatsApp:');
            qrcode.generate(qr, { small: true });
        } else {
            log('WARN', 'WhatsApp pide escanear un QR pero no hay consola interactiva. Detenga el servicio y ejecute "node ufinet_orion_whatsapp.js" manualmente para vincular.');
        }
    });
    c.on('authenticated', () => log('INFO', 'Sesión de WhatsApp autenticada.'));
    c.on('auth_failure', (m) => {
        if (client !== c) return;
        setReady(false);
        log('ERROR', `Fallo de autenticación de WhatsApp: ${m}. Si persiste, elimine la carpeta .wwebjs_auth y vuelva a vincular el QR.`);
    });
    c.on('ready', () => {
        if (client !== c) return;
        setReady(true);
        log('INFO', 'Cliente de WhatsApp conectado y listo.');
    });
    c.on('disconnected', (reason) => {
        if (client !== c) return;
        setReady(false);
        log('ERROR', `WhatsApp desconectado: ${reason}.${String(reason).toUpperCase() === 'LOGOUT' ? ' La sesión fue cerrada desde el teléfono: será necesario volver a escanear el QR de forma manual.' : ''}`);
        scheduleClientRestart('desconexión');
    });
    c.on('message', handleMessage);

    try {
        await c.initialize();
    } catch (e) {
        if (client !== c) return;
        log('ERROR', `No se pudo inicializar el cliente de WhatsApp: ${e && e.message ? e.message : e}`);
        setReady(false);
        scheduleClientRestart('error de inicialización');
    }
}

async function senderLoop() {
    let consecutiveSendFailures = 0;
    while (!shuttingDown) {
        if (!waReady || !client || state.outbox.length === 0) {
            await sleep(2000);
            continue;
        }
        const item = state.outbox[0];
        try {
            await client.sendMessage(cfg.target, item.text);
            state.outbox.shift();
            saveState();
            consecutiveSendFailures = 0;
            await sleep(cfg.sendDelayMs);
        } catch (e) {
            consecutiveSendFailures++;
            item.attempts = (item.attempts || 0) + 1;
            log('ERROR', `Fallo al enviar mensaje (intento ${item.attempts}): ${e && e.message ? e.message : e}`);
            if (item.attempts >= 10) {
                state.outbox.shift();
                log('ERROR', 'Mensaje descartado tras 10 intentos fallidos. Verifique el destino de WhatsApp.');
            }
            saveState();
            if (consecutiveSendFailures >= 5) {
                consecutiveSendFailures = 0;
                setReady(false);
                scheduleClientRestart('fallos repetidos de envío');
            }
            await sleep(Math.min(60000, 5000 * item.attempts));
        }
    }
}

function acquireInstanceLock() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', (e) => {
            if (e.code === 'EADDRINUSE') {
                const err = new Error('Ya hay otra instancia del bot en ejecución (servicio, tarea programada u otra consola). Deténgala antes de iniciar una nueva.');
                err.exitCode = 3;
                reject(err);
            } else {
                reject(e);
            }
        });
        server.listen(INSTANCE_PORT, '127.0.0.1', () => {
            instanceServer = server;
            resolve();
        });
    });
}

async function shutdown(code, reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `Cerrando el bot (${reason})...`);
    const hardKill = setTimeout(() => process.exit(code), 12000);
    try {
        saveState();
        await destroyClient();
        if (instanceServer) instanceServer.close();
    } catch (_) { /* ignorar */ }
    clearTimeout(hardKill);
    process.exit(code);
}

function startWatchdog() {
    setInterval(() => {
        if (shuttingDown || waReady || !everReady || !notReadySince) return;
        const minutes = (Date.now() - notReadySince) / 60000;
        if (minutes >= cfg.waRestartMinutes) {
            log('ERROR', `WhatsApp lleva ${Math.round(minutes)} min sin conexión; se reinicia el proceso para recuperarlo.`);
            shutdown(1, 'watchdog de WhatsApp');
        }
    }, 30000);
}

async function main() {
    ensureDir(LOG_DIR);
    log('INFO', '==================================================================');
    log('INFO', '   UFINET - SERVICIO DE NOTIFICACIONES SOLARWINDS ORION v2.0');
    log('INFO', '   Hecho por StinkyPinky');
    log('INFO', '==================================================================');

    await acquireInstanceLock();

    cfg = await loadOrCreateConfig();
    httpsAgent = buildHttpsAgent();
    loadState();

    killOrphanBrowsers();
    startClient();
    startWatchdog();
    senderLoop();
    log('INFO', `Sondeo periódico a Orion cada ${cfg.pollIntervalSeconds} s (confirmación: ${cfg.confirmDownCycles} sondeos para caída, ${cfg.confirmUpCycles} para recuperación).`);
    pollLoop();
}

process.on('SIGINT', () => shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGBREAK', () => shutdown(0, 'SIGBREAK'));
process.on('unhandledRejection', (reason) => {
    log('ERROR', `Promesa rechazada sin manejar: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
    log('ERROR', `Excepción no controlada: ${err && err.stack ? err.stack : err}`);
    shutdown(1, 'uncaughtException');
});

main().catch((e) => {
    log('ERROR', e && e.message ? e.message : String(e));
    process.exit(e && e.exitCode ? e.exitCode : 1);
});
