// Twitter Stock Ticker Extractor - Background Script
// Turso is the source of truth. Local storage only holds a small "outbox" of pairs that
// have not been uploaded yet (survives browser restarts, drained as uploads succeed).

// Browser API compatibility for Firefox
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const OUTBOX_LIMIT = 20000;   // oldest pending pairs are dropped beyond this (only if Turso is unreachable for ages)
const FLUSH_COUNT = 30;       // upload as soon as this many pairs are pending
const FLUSH_MAX_WAIT = 20000; // ...or this many ms after the first pending pair
const SEEN_LIMIT = 50000;     // session-only dedupe so the same post is not queued repeatedly

let outbox = new Map();       // "ticker|url" -> {ticker, url, timestamp}
const seenKeys = new Set();   // keys queued or uploaded during this browser session

// ---------- Turso credentials ----------

// Optional fallback: turso-config.js bundled in the extension folder (see scraper/make-extension-config.js).
// Fetched instead of listed in the manifest, so the extension still loads when the file is missing.
let fileConfigPromise = null;
function loadFileConfig() {
    if (!fileConfigPromise) {
        fileConfigPromise = fetch(browserAPI.runtime.getURL('turso-config.js'))
            .then(res => (res.ok ? res.text() : null))
            .then(text => {
                if (!text) return null;
                const cfg = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
                return cfg.url && cfg.authToken ? cfg : null;
            })
            .catch(() => null);
    }
    return fileConfigPromise;
}

// Credentials saved in the popup win; turso-config.js is used only when none are saved
async function getTursoConfig() {
    const result = await browserAPI.storage.local.get('tursoConfig');
    if (result.tursoConfig) {
        return result.tursoConfig;
    }
    const fileConfig = await loadFileConfig();
    if (fileConfig) {
        return fileConfig;
    }
    const err = new Error('Turso not configured - add credentials in the popup');
    err.notConfigured = true;
    throw err;
}

// Create/migrate the table once per credentials per session
let schemaReady = { url: null, promise: null };
function ensureSchemaOnce(config) {
    if (schemaReady.url !== config.url) {
        schemaReady = {
            url: config.url,
            promise: tursoEnsureSchema(config).catch(err => {
                schemaReady = { url: null, promise: null };
                throw err;
            })
        };
    }
    return schemaReady.promise;
}

// ---------- Outbox ----------

let persistTimer = null;
function persistOutbox() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        browserAPI.storage.local.set({ outbox: Object.fromEntries(outbox) }).catch(err => {
            console.error('Error saving outbox:', err);
        });
    }, 300);
}

async function loadOutbox() {
    try {
        const result = await browserAPI.storage.local.get(['outbox', 'tickerPairs']);
        outbox = new Map(Object.entries(result.outbox || {}));

        // Migrate data stored by older versions: it becomes pending uploads, then the old key is removed
        if (result.tickerPairs) {
            Object.entries(result.tickerPairs).forEach(([key, pair]) => outbox.set(key, pair));
            await browserAPI.storage.local.set({ outbox: Object.fromEntries(outbox) });
            await browserAPI.storage.local.remove('tickerPairs');
            console.log(`Migrated ${Object.keys(result.tickerPairs).length} stored pairs to the upload queue`);
        }
    } catch (err) {
        console.error('Error loading outbox:', err);
        outbox = new Map();
    }
    if (outbox.size > 0) scheduleFlush(2000);
}

const ready = loadOutbox();

function queuePairs(pairs) {
    let added = 0;
    for (const pair of pairs) {
        const key = `${pair.ticker}|${pair.url}`;
        if (seenKeys.has(key)) continue;
        if (seenKeys.size >= SEEN_LIMIT) seenKeys.clear();
        seenKeys.add(key);
        outbox.set(key, pair);
        added++;
    }
    while (outbox.size > OUTBOX_LIMIT) {
        outbox.delete(outbox.keys().next().value);
    }
    if (added > 0) {
        persistOutbox();
        // Upload at 30 pending pairs, or at most 20 seconds after the first pending pair.
        // While uploads are failing, the retry backoff decides instead.
        if (!retrying) {
            if (outbox.size >= FLUSH_COUNT) scheduleFlush(0);
            else if (!flushTimer) scheduleFlush(FLUSH_MAX_WAIT);
        }
    }
}

// Uploads are serialized; resolves with the number of pairs uploaded, rejects on failure
let flushChain = Promise.resolve();
function flushOutbox() {
    const run = flushChain.then(doFlush);
    flushChain = run.catch(() => {});
    return run;
}

async function doFlush() {
    await ready;
    if (outbox.size === 0) return 0;
    const entries = Array.from(outbox.entries());
    const config = await getTursoConfig();
    await ensureSchemaOnce(config);
    await tursoUploadPairs(config, entries.map(([, pair]) => pair), 'extension');
    entries.forEach(([key]) => outbox.delete(key)); // pairs queued meanwhile stay
    persistOutbox();
    console.log(`Uploaded ${entries.length} pairs to Turso (${outbox.size} pending)`);
    return entries.length;
}

let flushTimer = null;
let retrying = false;
let retryDelay = 30000;
function scheduleFlush(delay) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(autoFlush, delay);
}

async function autoFlush() {
    flushTimer = null;
    try {
        await flushOutbox();
        retrying = false;
        retryDelay = 30000;
        if (outbox.size > 0) scheduleFlush(1000); // pairs arrived during the upload
    } catch (err) {
        if (err.notConfigured) {
            // Nothing to retry against; saving credentials in the popup triggers an upload
            console.log(err.message);
            return;
        }
        console.error('Turso upload failed, will retry:', err);
        retrying = true;
        scheduleFlush(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 300000);
    }
}

// ---------- Messages from content script and popup ----------

function rangeCutoff(days) {
    return days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;
}

browserAPI.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'NEW_TICKER_PAIRS') {
        return ready.then(() => queuePairs(message.pairs));
    } else if (message.type === 'GET_OUTBOX_COUNT') {
        return ready.then(() => outbox.size);
    } else if (message.type === 'GET_TURSO_FILE_HOST') {
        // Lets the popup show that the turso-config.js fallback is in use (host only, never the token)
        return loadFileConfig().then(cfg => (cfg ? cfg.url.replace(/^\w+:\/\//, '') : null));
    } else if (message.type === 'GET_TOP_MENTIONS') {
        return getTursoConfig().then(config =>
            tursoTopMentions(config, rangeCutoff(message.days), 10, !!message.includeCrypto));
    } else if (message.type === 'GET_TOP_AUTHORS') {
        return getTursoConfig().then(config =>
            tursoTopAuthors(config, rangeCutoff(message.days), 10, !!message.includeCrypto));
    } else if (message.type === 'GET_DB_COUNTS') {
        return getTursoConfig().then(tursoCounts);
    } else if (message.type === 'SYNC_NOW') {
        return flushOutbox().then(count => ({ ok: true, count, pending: outbox.size }));
    } else if (message.type === 'SAVE_TURSO_CONFIG') {
        // Validate the credentials against Turso before storing them
        const config = message.config;
        return tursoEnsureSchema(config)
            .then(() => tursoCounts(config))
            .then(counts => browserAPI.storage.local.set({ tursoConfig: config }).then(() => {
                scheduleFlush(0); // upload anything that piled up while unconfigured
                return counts;
            }));
    }
});
