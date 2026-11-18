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
// whatsapp-web.js y qrcode-terminal se cargan dentro de startClient() para que
// el modo --verificar y las pruebas no dependan de Chromium.

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
    timezone: 'America/Managua',
    // Modo enlaces (vacío = monitorear todo Orion)
    watchlistFile: '',
    clientName: '',
    alertStatuses: [2, 8, 10, 12, 14],
    resolveIntervalMinutes: 360,
    portSuffixMatch: false,
    matchOrder: ['puerto', 'codigo', 'alias']
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
            port = (await ask(rl, 'Puerto API SWIS (por defecto 17774; en Orion 2015.x suele ser 17778): ')) || DEFAULTS.port;
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

        console.log('\nAlcance del monitoreo:');
        console.log('  Si indica un CSV con los enlaces (columnas: Código, Servicio, Switch, Puerto), solo se monitorean esos puertos.');
        const watchlistFile = await ask(rl, 'Archivo CSV de enlaces (vacío = monitorear todo Orion): ');
        const clientName = watchlistFile ? await ask(rl, 'Nombre del cliente para los mensajes (opcional): ') : '';

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
            timezone: DEFAULTS.timezone,
            watchlistFile,
            clientName,
            alertStatuses: DEFAULTS.alertStatuses,
            resolveIntervalMinutes: DEFAULTS.resolveIntervalMinutes,
            portSuffixMatch: DEFAULTS.portSuffixMatch,
            matchOrder: DEFAULTS.matchOrder
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
    c.watchlistFile = String(c.watchlistFile || '').trim();
    if (c.watchlistFile && !path.isAbsolute(c.watchlistFile)) c.watchlistFile = path.join(APP_DIR, c.watchlistFile);
    c.clientName = String(c.clientName || '').trim();
    const statuses = (Array.isArray(c.alertStatuses) ? c.alertStatuses : DEFAULTS.alertStatuses)
        .map(Number).filter((n) => Number.isInteger(n) && n !== 1);
    c.alertStatuses = statuses.length ? statuses : [...DEFAULTS.alertStatuses];
    c.resolveIntervalMinutes = num(c.resolveIntervalMinutes, DEFAULTS.resolveIntervalMinutes, 5, 10080);
    c.portSuffixMatch = c.portSuffixMatch === true;
    const order = (Array.isArray(c.matchOrder) ? c.matchOrder : DEFAULTS.matchOrder).map((s) => String(s).toLowerCase()).filter((s) => ['puerto', 'codigo', 'alias'].includes(s));
    c.matchOrder = order.length ? [...new Set(order)] : [...DEFAULTS.matchOrder];
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

let state = { version: 1, active: {}, outbox: [], orionDown: false, unresolvedSig: '' };

function loadState() {
    if (!fs.existsSync(STATE_FILE)) return;
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
        state = {
            version: 1,
            active: parsed && typeof parsed.active === 'object' && parsed.active ? parsed.active : {},
            outbox: Array.isArray(parsed && parsed.outbox) ? parsed.outbox : [],
            orionDown: Boolean(parsed && parsed.orionDown),
            unresolvedSig: String((parsed && parsed.unresolvedSig) || '')
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
        statusText = e.statusText || 'DOWN [CRÍTICO]';
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

function reconcile(kind, entities, upKeys) {
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
        // Con upKeys, solo se recupera lo que Orion reporta Up; Unmanaged, Shutdown, etc. no cuentan.
        if (upKeys && !upKeys.has(key)) {
            upCounts.delete(key);
            continue;
        }
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

function noteOrionFailure(detail) {
    consecutiveFailures++;
    log('ERROR', `Fallo al consultar Orion (intento ${consecutiveFailures}): ${detail}`);
    if (consecutiveFailures >= cfg.orionFailAlertAfter && !state.orionDown) {
        state.orionDown = true;
        enqueue(msgOrionDown(detail));
    }
    saveState();
}

function noteOrionSuccess() {
    consecutiveFailures = 0;
    if (state.orionDown) {
        state.orionDown = false;
        enqueue(msgOrionRestored());
        log('INFO', 'Conexión con Orion restablecida.');
    }
}

async function pollOnce() {
    if (cfg.watchlistFile) return pollWatchlist();
    log('INFO', 'Verificando nodos y aplicaciones en Orion...');

    const [nodesRes, appsRes] = await Promise.all([
        safeQuery(fetchNodes),
        cfg.monitorApplications ? safeQuery(() => queryOrionSWIS(APPS_QUERY)) : Promise.resolve(null)
    ]);
    lastPollAt = Date.now();

    if (nodesRes.error) {
        noteOrionFailure(nodesRes.error);
        return;
    }
    noteOrionSuccess();

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

/* ==============================================================================
   MODO ENLACES: monitorea solo las interfaces (puertos) listadas en un CSV.
   Se activa con "watchlistFile" en ufinet_config.json. Sin esa clave, el bot
   funciona como antes (todos los nodos y aplicaciones caídos de Orion).
   ============================================================================== */

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// Nombres aceptados para cada columna del CSV (sin acentos, minúsculas, sin símbolos).
const CSV_COLUMNS = {
    code: ['codigoadministrativo', 'codigo', 'codigoservicio', 'idservicio', 'id'],
    service: ['nombredelservicio', 'nombreservicio', 'servicio', 'nombre'],
    switchName: ['switch', 'nodo', 'equipo', 'sw'],
    port: ['puerto', 'port', 'interfaz', 'interface']
};

// Etiquetas de estado de Orion. Se reemplazan con Orion.StatusInfo al resolver.
let statusNames = { 1: 'Up', 2: 'Down', 3: 'Warning', 9: 'Unmanaged', 10: 'Unplugged', 12: 'Unreachable', 14: 'Critical' };
const statusLabel = (n) => statusNames[n] || `estado ${n}`;

const RESULT_TEXT = {
    ok: 'ubicado',
    switch_no_encontrado: 'switch no encontrado en Orion',
    no_encontrado: 'interfaz no encontrada',
    ambiguo: 'coincide con varias entidades',
    sugerido: 'sin coincidencia exacta (hay una sugerencia)'
};

function normHeader(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function queryChunks(items, size, build) {
    const out = [];
    for (const part of chunk(items, size)) out.push(...(await queryOrionSWIS(build(part))));
    return out;
}

// CSV mínimo: separador "," o ";" (se detecta en el encabezado), comillas dobles, BOM.
function parseCsv(text) {
    const src = String(text).replace(/^﻿/, '');
    const firstLine = src.split(/\r?\n/, 1)[0] || '';
    const delim = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const endRow = () => {
        row.push(field);
        field = '';
        if (row.some((v) => v.trim() !== '')) rows.push(row);
        row = [];
    };
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inQuotes) {
            if (c === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
            } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === delim) { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && src[i + 1] === '\n') i++;
            endRow();
        } else field += c;
    }
    endRow();
    return rows;
}

// Devuelve los enlaces únicos (switch + puerto). Varios servicios pueden compartir un puerto.
function loadWatchlist(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw new Error(`No se pudo leer la lista de enlaces '${file}': ${e.message}`);
    }
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error(`La lista de enlaces '${file}' está vacía (se esperan encabezados y al menos una fila).`);

    const headers = rows[0].map(normHeader);
    const col = {};
    for (const [field, names] of Object.entries(CSV_COLUMNS)) {
        const idx = headers.findIndex((h) => names.includes(h));
        if (idx >= 0) col[field] = idx;
    }
    if (col.switchName === undefined || col.port === undefined) {
        throw new Error(`La lista '${file}' necesita las columnas "Switch" y "Puerto". Encabezados encontrados: ${rows[0].join(', ')}`);
    }

    const links = new Map();
    const issues = [];
    rows.slice(1).forEach((r, i) => {
        const get = (f) => (col[f] === undefined ? '' : String(r[col[f]] || '').trim());
        const sw = get('switchName');
        const port = get('port');
        if (!sw || !port) {
            issues.push(`Lista de enlaces, fila ${i + 2}: falta switch o puerto; se omite.`);
            return;
        }
        const type = IPV4_RE.test(port) ? 'node' : 'interface';
        const key = `${type}|${sw.toLowerCase()}|${port.toLowerCase()}`;
        let link = links.get(key);
        if (!link) {
            link = { key, type, switchName: sw, port, services: [] };
            links.set(key, link);
        }
        const svc = { code: get('code'), name: get('service') };
        if (!link.services.some((s) => s.code === svc.code && s.name === svc.name)) link.services.push(svc);
    });
    return { links, issues };
}

const ifaceNames = (i, fields) =>
    fields.map((f) => i[f]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map(String);

const describeCandidates = (list) =>
    list.slice(0, 5).map((i) => `${i.Name || i.Caption} (InterfaceID ${i.InterfaceID})`).join('; ');

// Busca la interfaz de un switch que corresponde a "port30".
//  1) Coincidencia exacta con Name, Caption, InterfaceName o InterfaceAlias (ignora mayúsculas y símbolos).
//  2) Si no hay, coincidencia por el número final del nombre ("ge-0/0/30" para "port30"). Solo se acepta si
//     portSuffixMatch=true: una coincidencia por número puede ser la interfaz equivocada. Si está desactivada,
//     se informa como "sugerido" y NO se monitorea.
function matchInterface(ifaces, port, allowSuffix) {
    const target = squash(port);
    const exact = ifaces.filter((i) => ifaceNames(i, ['Name', 'Caption', 'InterfaceName', 'InterfaceAlias']).some((t) => squash(t) === target));
    if (exact.length === 1) return { result: 'ok', iface: exact[0], via: 'exacta' };
    if (exact.length > 1) return { result: 'ambiguo', detail: `Varias interfaces coinciden: ${describeCandidates(exact)}` };

    const m = /(\d+)$/.exec(String(port).trim());
    if (m) {
        const re = new RegExp(`(^|[^0-9])${m[1]}$`);
        const suffix = ifaces.filter((i) => ifaceNames(i, ['Name', 'InterfaceName']).some((t) => re.test(t.trim())));
        if (suffix.length === 1 && allowSuffix) return { result: 'ok', iface: suffix[0], via: 'por número final' };
        if (suffix.length === 1) {
            return {
                result: 'sugerido',
                iface: suffix[0],
                detail: `Sin coincidencia exacta. Sugerencia: ${describeCandidates(suffix)}. Si es correcta, ponga "portSuffixMatch": true.`
            };
        }
        if (suffix.length > 1) return { result: 'ambiguo', detail: `Varias interfaces terminan en ${m[1]}: ${describeCandidates(suffix)}` };
    }
    return {
        result: 'no_encontrado',
        detail: ifaces.length
            ? `El switch tiene ${ifaces.length} interfaces en Orion y ninguna coincide con '${port}'.`
            : 'El switch no tiene interfaces en Orion (¿NPM no las está monitoreando?).'
    };
}

async function loadStatusNames() {
    try {
        const rows = await queryOrionSWIS('SELECT StatusId, StatusName FROM Orion.StatusInfo');
        const map = {};
        for (const r of rows) if (r.StatusName) map[Number(r.StatusId)] = String(r.StatusName);
        if (Object.keys(map).length) statusNames = map;
    } catch (e) {
        log('WARN', `No se pudo leer Orion.StatusInfo; se usan etiquetas de estado por defecto: ${describeError(e)}`);
    }
}

const CODE_MIN_LEN = 8;
const MATCH_STRATEGIES = ['puerto', 'codigo', 'alias'];

const textsOf = (i) => ifaceNames(i, ['Name', 'Caption', 'InterfaceName', 'InterfaceAlias']);
const ifaceLabel = (i) => `${i.Name || i.Caption} (InterfaceID ${i.InterfaceID}${i.NodeCaption ? `, ${i.NodeCaption}` : ''})`;

function codeRegex(code) {
    return new RegExp(`(^|[^A-Za-z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i');
}

function uniqueById(rows) {
    const seen = new Map();
    for (const r of rows) seen.set(Number(r.InterfaceID), r);
    return [...seen.values()];
}

// Interfaces (de cualquier equipo) cuyo Caption o descripción contiene alguno de los textos.
async function findInterfacesLike(tokens) {
    const rows = await queryChunks(tokens, 8, (p) => {
        const conds = p.map((t) => `Caption LIKE ${sqlStr(`%${t}%`)} OR InterfaceAlias LIKE ${sqlStr(`%${t}%`)}`).join(' OR ');
        return `SELECT InterfaceID, NodeID, Name, Caption, InterfaceName, InterfaceAlias, Status, Node.Caption AS NodeCaption FROM Orion.NPM.Interfaces WHERE ${conds}`;
    });
    return uniqueById(rows);
}

// En Orion 2015.x el campo de IP puede llamarse IPAddress o IP_Address: se prueba con respaldo.
async function queryNodesByIp(ips) {
    const build = (field) => (p) =>
        `SELECT NodeID, Caption, ${field === 'IPAddress' ? 'IPAddress' : `${field} AS IPAddress`}, Status FROM Orion.Nodes WHERE ${field} IN (${p.map(sqlStr).join(', ')})`;
    try {
        return await queryChunks(ips, 40, build('IPAddress'));
    } catch (e) {
        if (e && e.response && e.response.status === 400) return queryChunks(ips, 40, build('IP_Address'));
        throw e;
    }
}

// Ubica cada fila de la lista en Orion con hasta tres estrategias, en el orden de cfg.matchOrder:
//   puerto : nodo con el nombre del switch + interfaz con el nombre del puerto
//   codigo : interfaz cuya descripción contiene el código del servicio (NINI...)
//   alias  : interfaz (de cualquier equipo) cuya descripción nombra al switch y "portN"
// Se usa la primera estrategia que da exactamente un resultado. Nunca adivina: si una estrategia
// da varios, o ninguna da nada, la fila queda en el reporte y no se monitorea. Si otra estrategia
// apunta a una interfaz distinta, se informa como "difiere" para que se revise.
async function resolveLinks(links) {
    const all = [...links.values()];
    const ifaceLinks = all.filter((l) => l.type === 'interface');
    const nodeLinks = all.filter((l) => l.type === 'node');
    const order = cfg.matchOrder.filter((s) => MATCH_STRATEGIES.includes(s));
    const report = [];

    const swNames = [...new Set(ifaceLinks.map((l) => l.switchName))];

    // --- datos de la estrategia "puerto": switches por nombre (Caption; si no, SysName o DNS) e interfaces
    const nodeByName = new Map();
    const ifacesByNode = new Map();
    if (order.includes('puerto') && swNames.length) {
        const addNode = (n, name) => {
            const k = String(name || '').trim().toLowerCase();
            if (!k) return;
            const arr = nodeByName.get(k) || [];
            if (!arr.some((x) => x.NodeID === n.NodeID)) arr.push(n);
            nodeByName.set(k, arr);
        };
        const byCaption = await queryChunks(swNames, 40, (p) =>
            `SELECT NodeID, Caption, Status FROM Orion.Nodes WHERE Caption IN (${p.map(sqlStr).join(', ')})`);
        byCaption.forEach((n) => addNode(n, n.Caption));

        const missing = swNames.filter((n) => !nodeByName.has(n.toLowerCase()));
        if (missing.length) {
            try {
                const alt = await queryChunks(missing, 40, (p) => {
                    const list = p.map(sqlStr).join(', ');
                    return `SELECT NodeID, Caption, Status, DNS, SysName FROM Orion.Nodes WHERE SysName IN (${list}) OR DNS IN (${list})`;
                });
                alt.forEach((n) => { addNode(n, n.SysName); addNode(n, n.DNS); });
            } catch (e) {
                log('WARN', `Búsqueda alterna de switches por SysName/DNS falló: ${describeError(e)}`);
            }
        }
        const nodeIds = [...new Set([...nodeByName.values()].flat().map((n) => Number(n.NodeID)))];
        const ifRows = await queryChunks(nodeIds, 10, (p) =>
            `SELECT InterfaceID, NodeID, Name, Caption, InterfaceName, InterfaceAlias, Status FROM Orion.NPM.Interfaces WHERE NodeID IN (${p.join(', ')})`);
        for (const r of ifRows) {
            const k = Number(r.NodeID);
            if (!ifacesByNode.has(k)) ifacesByNode.set(k, []);
            ifacesByNode.get(k).push(r);
        }
    }

    // --- datos de las estrategias "codigo" y "alias"
    let codeRows = [];
    if (order.includes('codigo')) {
        const codes = [...new Set(ifaceLinks.flatMap((l) => l.services.map((s) => s.code)).filter((c) => c.length >= CODE_MIN_LEN))];
        if (codes.length) codeRows = await findInterfacesLike(codes);
    }
    let aliasRows = [];
    if (order.includes('alias') && swNames.length) aliasRows = await findInterfacesLike(swNames);

    const strategies = {
        puerto(link) {
            const nodes = nodeByName.get(link.switchName.toLowerCase()) || [];
            if (nodes.length === 0) {
                return { found: [], reason: 'switch_no_encontrado', detail: 'Ningún nodo de Orion se llama así (se buscó en Caption, SysName y DNS).' };
            }
            if (nodes.length > 1) {
                return { found: [], ambiguous: true, detail: `El switch coincide con ${nodes.length} nodos (NodeID ${nodes.map((n) => n.NodeID).join(', ')}).` };
            }
            const node = nodes[0];
            const m = matchInterface(ifacesByNode.get(Number(node.NodeID)) || [], link.port, cfg.portSuffixMatch);
            if (m.result === 'ok') return { found: [m.iface], node, via: m.via };
            if (m.result === 'ambiguo') return { found: [], ambiguous: true, detail: m.detail, node };
            return { found: [], reason: m.result, detail: m.detail, suggestion: m.iface, node };
        },
        codigo(link) {
            const res = link.services.map((s) => s.code).filter((c) => c.length >= CODE_MIN_LEN).map(codeRegex);
            if (!res.length) return { found: [], detail: 'Las filas de este enlace no traen un código utilizable.' };
            return { found: codeRows.filter((i) => res.some((re) => textsOf(i).some((t) => re.test(t)))) };
        },
        alias(link) {
            const m = /(\d+)$/.exec(link.port);
            if (!m) return { found: [] };
            const sw = link.switchName.toLowerCase();
            const portRe = new RegExp(`(^|[^a-z0-9])port0*${m[1]}(?![0-9])`, 'i');
            return {
                found: aliasRows.filter((i) => textsOf(i).some((t) => t.toLowerCase().includes(sw)) && textsOf(i).some((t) => portRe.test(t)))
            };
        }
    };

    const interfaces = new Map();
    for (const link of ifaceLinks) {
        const outcomes = {};
        for (const s of order) outcomes[s] = strategies[s](link);

        let chosen = null;
        let chosenBy = null;
        let blocked = null;
        for (const s of order) {
            const o = outcomes[s];
            if (o.found.length === 1) { chosen = o.found[0]; chosenBy = s; break; }
            if (o.found.length > 1 || o.ambiguous) { blocked = { s, o }; break; }
        }

        if (!chosen) {
            const p = outcomes.puerto;
            const tried = `Se probó: ${order.join(', ')}.`;
            if (blocked) {
                report.push({
                    link, result: 'ambiguo', node: p && p.node,
                    detail: `Por ${blocked.s}: ${blocked.o.detail || `${blocked.o.found.length} interfaces: ${describeCandidates(blocked.o.found)}`}`
                });
            } else if (p && p.reason === 'switch_no_encontrado') {
                report.push({ link, result: 'switch_no_encontrado', detail: `${p.detail} ${tried}` });
            } else if (p && p.suggestion) {
                report.push({ link, result: 'sugerido', detail: p.detail, node: p.node, iface: p.suggestion });
            } else {
                report.push({ link, result: 'no_encontrado', node: p && p.node, detail: `${(p && p.detail) || 'Ninguna estrategia encontró la interfaz.'} ${tried}` });
            }
            continue;
        }

        const alt = order
            .filter((s) => s !== chosenBy && outcomes[s].found.length === 1 && Number(outcomes[s].found[0].InterfaceID) !== Number(chosen.InterfaceID))
            .map((s) => `${s} apunta a ${ifaceLabel(outcomes[s].found[0])}`);
        const agree = order
            .filter((s) => s !== chosenBy && outcomes[s].found.length === 1 && Number(outcomes[s].found[0].InterfaceID) === Number(chosen.InterfaceID));
        report.push({
            link, result: 'ok', via: chosenBy, iface: chosen, node: outcomes.puerto && outcomes.puerto.node, alt, agree,
            detail: `Ubicado por ${chosenBy}${agree.length ? ` (confirmado también por ${agree.join(', ')})` : ''}`
        });
        const id = Number(chosen.InterfaceID);
        let entry = interfaces.get(id);
        if (!entry) {
            entry = { id, iface: chosen, node: outcomes.puerto && outcomes.puerto.node, links: [] };
            interfaces.set(id, entry);
        }
        entry.links.push(link);
    }

    // --- filas cuyo "puerto" es una IP: se vigila el nodo completo
    const nodes = new Map();
    if (nodeLinks.length) {
        const ips = [...new Set(nodeLinks.map((l) => l.port))];
        const rows = await queryNodesByIp(ips);
        for (const link of nodeLinks) {
            const found = rows.filter((n) => String(n.IPAddress).trim() === link.port);
            if (found.length !== 1) {
                report.push({
                    link,
                    result: found.length ? 'ambiguo' : 'no_encontrado',
                    detail: found.length ? `La IP coincide con ${found.length} nodos.` : 'Ningún nodo de Orion tiene esa IP.'
                });
                continue;
            }
            const node = found[0];
            report.push({ link, result: 'ok', via: 'ip', detail: 'Nodo ubicado por IP', node });
            const id = Number(node.NodeID);
            let entry = nodes.get(id);
            if (!entry) {
                entry = { id, node, links: [] };
                nodes.set(id, entry);
            }
            entry.links.push(link);
        }
    }

    return { interfaces, nodes, report };
}

let watch = null;
let watchResolvedAt = 0;

function msgUnresolved(unresolved, total) {
    const MAX = 15;
    const lines = [
        '⚠️ *MONITOREO UFINET - SOLARWINDS* ⚠️',
        '',
        `🔎 *${unresolved.length} de ${total} enlaces${cfg.clientName ? ` de ${cfg.clientName}` : ''} no se pudieron ubicar en Orion* y NO se están monitoreando.`,
        ''
    ];
    for (const r of unresolved.slice(0, MAX)) lines.push(`• ${r.link.switchName} ${r.link.port} — ${RESULT_TEXT[r.result] || r.result}`);
    if (unresolved.length > MAX) lines.push(`… y ${unresolved.length - MAX} más`);
    lines.push('', 'Detalle completo: ejecute "node ufinet_orion_whatsapp.js --verificar" en el servidor.', `🕒 *Hora:* ${fmtDateTime(Date.now())}`, '', FOOTER);
    return lines.join('\n');
}

function msgAllResolved(total) {
    return [
        '✅ *MONITOREO UFINET - SOLARWINDS* ✅',
        '',
        `🔎 Los ${total} enlaces de la lista ya están ubicados en Orion y bajo monitoreo.`,
        `🕒 *Hora:* ${fmtDateTime(Date.now())}`,
        '',
        FOOTER
    ].join('\n');
}

// Aplica una resolución nueva: avisa (una vez) si cambian los enlaces sin ubicar y
// descarta alertas activas de entidades que ya no están en la lista.
function applyResolution() {
    const { interfaces, nodes, report } = watch;
    const unresolved = report.filter((r) => r.result !== 'ok');
    log('INFO', `Enlaces: ${watch.total} en la lista, ${report.length - unresolved.length} ubicados, ${unresolved.length} sin ubicar.`);
    for (const r of report.filter((x) => x.alt && x.alt.length)) {
        log('WARN', `Revisar enlace ${r.link.switchName} ${r.link.port}: se monitorea ${ifaceLabel(r.iface)} (por ${r.via}), pero ${r.alt.join('; ')}.`);
    }
    for (const r of unresolved) log('WARN', `Enlace sin monitorear: ${r.link.switchName} ${r.link.port} — ${RESULT_TEXT[r.result] || r.result}. ${r.detail || ''}`);

    const sig = unresolved.map((r) => `${r.link.key}:${r.result}`).sort().join('|');
    if (sig !== state.unresolvedSig) {
        if (unresolved.length) enqueue(msgUnresolved(unresolved, watch.total));
        else if (state.unresolvedSig) enqueue(msgAllResolved(watch.total));
        state.unresolvedSig = sig;
    }

    const valid = new Set([...interfaces.keys()].map((id) => `if_${id}`).concat([...nodes.keys()].map((id) => `node_${id}`)));
    for (const key of Object.keys(state.active)) {
        if (!valid.has(key)) {
            log('INFO', `Se descarta la alerta activa '${state.active[key].name}' porque ya no pertenece a la lista de enlaces.`);
            delete state.active[key];
        }
    }
    saveState();
}

async function ensureResolved() {
    const due = !watch || Date.now() - watchResolvedAt >= cfg.resolveIntervalMinutes * 60000;
    if (!due) return;
    try {
        const list = loadWatchlist(cfg.watchlistFile);
        list.issues.forEach((m) => log('WARN', m));
        if (!watch) await loadStatusNames();
        const res = await resolveLinks(list.links);
        watch = { ...res, total: list.links.size };
        watchResolvedAt = Date.now();
        applyResolution();
    } catch (e) {
        if (!watch) throw e;
        log('WARN', `No se pudo refrescar la lista de enlaces; se usa la resolución anterior: ${describeError(e)}`);
        watchResolvedAt = Date.now() - cfg.resolveIntervalMinutes * 60000 + 5 * 60000; // reintenta en 5 min
    }
}

const serviceInfo = (links) => {
    const services = links.flatMap((l) => l.services);
    return {
        names: [...new Set(services.map((s) => s.name).filter(Boolean))],
        codes: [...new Set(services.map((s) => s.code).filter(Boolean))]
    };
};

const SWITCH_BAD = [2, 12]; // switch Down o Unreachable: sus puertos tampoco se pueden verificar

function entityForInterface(entry, st, nodeSt) {
    const first = entry.links[0];
    const { names, codes } = serviceInfo(entry.links);
    const ifName = entry.iface.Name || entry.iface.Caption || `InterfaceID ${entry.id}`;
    const device = entry.iface.NodeCaption || first.switchName;
    const ownBad = cfg.alertStatuses.includes(st);
    const nodeBad = SWITCH_BAD.includes(nodeSt);
    const parts = [ownBad
        ? `Interfaz ${ifName} en ${device}: ${statusLabel(st)}.`
        : `No se alcanza el equipo ${device} (${statusLabel(nodeSt)}).`];
    if (ownBad && nodeBad) parts.push(`El equipo está ${statusLabel(nodeSt)}.`);
    if (codes.length) parts.push(`Código(s): ${codes.join(', ')}.`);
    let statusText;
    if (!ownBad && nodeBad) statusText = 'SWITCH INALCANZABLE';
    else if (st !== 2) statusText = statusLabel(st).toUpperCase();
    return {
        key: `if_${entry.id}`,
        kind: 'if',
        name: names.length ? names.join(' + ') : `${first.switchName} ${first.port}`,
        type: `Enlace${cfg.clientName ? ` ${cfg.clientName}` : ''} (${first.switchName} ${first.port})`,
        status: st,
        statusText,
        ip: '',
        details: parts.join(' ')
    };
}

function entityForNode(entry, st) {
    const first = entry.links[0];
    const { names, codes } = serviceInfo(entry.links);
    return {
        key: `node_${entry.id}`,
        kind: 'node',
        name: names.length ? names.join(' + ') : (entry.node.Caption || `NodeID ${entry.id}`),
        type: `Nodo del enlace${cfg.clientName ? ` ${cfg.clientName}` : ''} (${first.switchName})`,
        status: st,
        statusText: st === 2 ? undefined : statusLabel(st).toUpperCase(),
        ip: entry.node.IPAddress || first.port,
        details: `Nodo ${entry.node.Caption || entry.id}: ${statusLabel(st)}.${codes.length ? ` Código(s): ${codes.join(', ')}.` : ''}`
    };
}

async function fetchWatchedStatuses() {
    const ifaceIds = [...watch.interfaces.keys()];
    const nodeIds = [...watch.nodes.keys()];
    const ifaceRows = await queryChunks(ifaceIds, 200, (p) =>
        `SELECT InterfaceID, Status, Node.Status AS NodeStatus FROM Orion.NPM.Interfaces WHERE InterfaceID IN (${p.join(', ')})`);
    const nodeRows = await queryChunks(nodeIds, 200, (p) =>
        `SELECT NodeID, Status FROM Orion.Nodes WHERE NodeID IN (${p.join(', ')})`);
    return { ifaceRows, nodeRows };
}

// Una entidad se da por recuperada SOLO si Orion la reporta Up (1). Estados como Unmanaged o
// Shutdown no son una recuperación: la alerta sigue activa hasta que realmente esté Up.
async function pollWatchlist() {
    log('INFO', 'Verificando enlaces del cliente en Orion...');
    let data;
    try {
        await ensureResolved();
        data = await fetchWatchedStatuses();
    } catch (e) {
        lastPollAt = Date.now();
        noteOrionFailure(describeError(e));
        return;
    }
    lastPollAt = Date.now();
    noteOrionSuccess();

    const ifDown = [];
    const ifUp = new Set();
    for (const row of data.ifaceRows) {
        const entry = watch.interfaces.get(Number(row.InterfaceID));
        if (!entry) continue;
        const st = Number(row.Status);
        const nodeSt = Number(row.NodeStatus);
        if (cfg.alertStatuses.includes(st) || SWITCH_BAD.includes(nodeSt)) ifDown.push(entityForInterface(entry, st, nodeSt));
        else if (st === 1) ifUp.add(`if_${entry.id}`);
    }

    const nodeDown = [];
    const nodeUp = new Set();
    for (const row of data.nodeRows) {
        const entry = watch.nodes.get(Number(row.NodeID));
        if (!entry) continue;
        const st = Number(row.Status);
        if (cfg.alertStatuses.includes(st) || SWITCH_BAD.includes(st)) nodeDown.push(entityForNode(entry, st));
        else if (st === 1) nodeUp.add(`node_${entry.id}`);
    }

    const ifEvents = reconcile('if', ifDown, ifUp);
    const nodeEvents = reconcile('node', nodeDown, nodeUp);
    enqueueEvents(ifEvents.newDown, 'down');
    enqueueEvents(nodeEvents.newDown, 'down');
    enqueueEvents(ifEvents.recovered, 'up');
    enqueueEvents(nodeEvents.recovered, 'up');
    saveState();

    const newDown = ifEvents.newDown.length + nodeEvents.newDown.length;
    const recovered = ifEvents.recovered.length + nodeEvents.recovered.length;
    log('INFO', `Sondeo completado: ${watch.interfaces.size + watch.nodes.size} vigilada(s), ${Object.keys(state.active).length} activa(s), ${newDown} nueva(s) caída(s), ${recovered} recuperación(es), ${state.outbox.length} mensaje(s) en cola.`);
}

// "node ufinet_orion_whatsapp.js --verificar": comprueba la lista contra Orion sin WhatsApp ni alertas.
async function runVerify() {
    cfg = await loadOrCreateConfig();
    httpsAgent = buildHttpsAgent();
    if (!cfg.watchlistFile) {
        throw new Error('No hay "watchlistFile" en la configuración: el bot está en modo "todo Orion". Agregue la ruta del CSV de enlaces.');
    }
    const list = loadWatchlist(cfg.watchlistFile);
    list.issues.forEach((m) => console.log(`[AVISO] ${m}`));
    console.log(`\nLista: ${cfg.watchlistFile}`);
    console.log(`Enlaces únicos (switch + puerto): ${list.links.size}`);
    console.log('Consultando Orion...\n');

    await loadStatusNames();
    let res;
    try {
        res = await resolveLinks(list.links);
    } catch (e) {
        const code = e && e.code;
        if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(code)) {
            console.log(`\n[ERROR] No se pudo conectar a Orion en ${cfg.url}:${cfg.port} (${code}).`);
            console.log('Pistas: Orion 2015.x suele exponer la API SWIS por HTTPS en el puerto 17778 (versiones nuevas: 17774).');
            console.log('Pruebe con "port": "17778" en ufinet_config.json y confirme que el firewall permite la salida.');
        }
        throw e;
    }
    const counts = {};
    for (const r of res.report) counts[r.result] = (counts[r.result] || 0) + 1;

    console.log('RESULTADO');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(4)}  ${RESULT_TEXT[k] || k}`);

    const problems = res.report.filter((r) => r.result !== 'ok');
    if (problems.length) {
        console.log('\nENLACES QUE NO SE MONITOREARÍAN');
        for (const r of problems) console.log(`  - ${r.link.switchName} ${r.link.port}: ${RESULT_TEXT[r.result] || r.result}. ${r.detail || ''}`);
    }
    const differ = res.report.filter((r) => r.alt && r.alt.length);
    if (differ.length) {
        console.log('\nENLACES UBICADOS, PERO CON OTRA ESTRATEGIA EN DESACUERDO (revise cuál es la interfaz correcta)');
        for (const r of differ) console.log(`  - ${r.link.switchName} ${r.link.port}: se usaría ${ifaceLabel(r.iface)} (por ${r.via}); ${r.alt.join('; ')}`);
    }
    console.log(`\nEstrategias (cfg.matchOrder): ${cfg.matchOrder.join(' > ')}`);
    console.log(`\nEstados que generan alerta: ${cfg.alertStatuses.map((s) => `${s}=${statusLabel(s)}`).join(', ')}`);
    console.log('Se da por recuperado solo con 1=' + statusLabel(1) + '.');

    const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['switch', 'puerto', 'codigos', 'servicios', 'resultado', 'estrategia', 'detalle', 'desacuerdos', 'interfaz_orion', 'equipo_orion', 'interface_id', 'estado_actual', 'node_id'];
    const lines = [head.join(';')];
    for (const r of res.report) {
        const { names, codes } = serviceInfo([r.link]);
        lines.push([
            r.link.switchName, r.link.port, codes.join(' | '), names.join(' | '), RESULT_TEXT[r.result] || r.result, r.via || '', r.detail || '', (r.alt || []).join(' | '),
            r.iface ? (r.iface.Name || r.iface.Caption) : '', r.iface ? (r.iface.NodeCaption || (r.node && r.node.Caption) || '') : '', r.iface ? r.iface.InterfaceID : '',
            r.iface && r.iface.Status !== undefined ? statusLabel(Number(r.iface.Status)) : (r.node ? statusLabel(Number(r.node.Status)) : ''),
            r.node ? r.node.NodeID : (r.iface ? r.iface.NodeID : '')
        ].map(esc).join(';'));
    }
    ensureDir(LOG_DIR);
    const out = path.join(LOG_DIR, 'verificacion_enlaces.csv');
    fs.writeFileSync(out, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
    console.log(`\nReporte completo: ${out}`);
    process.exitCode = problems.length ? 2 : 0;
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
    const { Client, LocalAuth } = require('whatsapp-web.js');
    const qrcode = require('qrcode-terminal');
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
    if (process.argv.includes('--verificar')) {
        await runVerify();
        return;
    }
    log('INFO', '==================================================================');
    log('INFO', '   UFINET - SERVICIO DE NOTIFICACIONES SOLARWINDS ORION v2.0');
    log('INFO', '   Hecho por StinkyPinky');
    log('INFO', '==================================================================');

    await acquireInstanceLock();

    cfg = await loadOrCreateConfig();
    httpsAgent = buildHttpsAgent();
    loadState();

    if (cfg.watchlistFile) {
        // Falla rápido si el CSV no existe o no es válido, en vez de caer a "todo Orion" y generar un alud de alertas.
        const wl = loadWatchlist(cfg.watchlistFile);
        wl.issues.forEach((m) => log('WARN', m));
        log('INFO', `Modo enlaces${cfg.clientName ? ` (${cfg.clientName})` : ''}: ${wl.links.size} enlace(s) en '${path.basename(cfg.watchlistFile)}'.`);
    } else {
        log('INFO', 'Modo general: se monitorean todos los nodos y aplicaciones caídos de Orion.');
    }

    killOrphanBrowsers();
    startClient();
    startWatchdog();
    senderLoop();
    log('INFO', `Sondeo periódico a Orion cada ${cfg.pollIntervalSeconds} s (confirmación: ${cfg.confirmDownCycles} sondeos para caída, ${cfg.confirmUpCycles} para recuperación).`);
    pollLoop();
}

if (require.main === module) {
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
}

// Expuesto para pruebas automáticas (no se usa en producción).
module.exports = {
    parseCsv, loadWatchlist, matchInterface, resolveLinks, ensureResolved, pollWatchlist, pollOnce, reconcile,
    getState: () => state,
    getWatch: () => watch,
    setConfig: (raw) => { cfg = validateConfig(raw); httpsAgent = buildHttpsAgent(); },
    resetRuntime: () => {
        watch = null;
        watchResolvedAt = 0;
        consecutiveFailures = 0;
        pendingDown.clear();
        upCounts.clear();
        state = { version: 1, active: {}, outbox: [], orionDown: false, unresolvedSig: '' };
    }
};
