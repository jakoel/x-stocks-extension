// Popup script for Twitter Ticker Extractor

// Browser API compatibility for Firefox
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const $ = id => document.getElementById(id);

const statLocal = $('statLocal');
const statDbPairs = $('statDbPairs');
const statDbTickers = $('statDbTickers');
const timeFilter = $('timeFilter');
const showTopBtn = $('showTopBtn');
const messageEl = $('message');
const resultsDiv = $('results');
const resultsMeta = $('resultsMeta');
const resultsContent = $('resultsContent');
const resultsPlaceholder = $('resultsPlaceholder');
const autoScrollBtn = $('autoScrollBtn');
const autoScrollIcon = $('autoScrollIcon');
const autoScrollLabel = $('autoScrollLabel');
const scrollStatus = $('scrollStatus');
const scrollStatusText = $('scrollStatusText');
const tursoUrlInput = $('tursoUrl');
const tursoTokenInput = $('tursoToken');
const saveTursoBtn = $('saveTursoBtn');
const toggleTursoBtn = $('toggleTursoBtn');
const tursoSection = $('tursoSection');
const tursoStatus = $('tursoStatus');
const clearTursoBtn = $('clearTursoBtn');
const uploadBtn = $('uploadBtn');
const stopDateInput = $('stopDate');
const clearDateBtn = $('clearDateBtn');
const deadlineHint = $('deadlineHint');
const modeTickers = $('modeTickers');
const modeAuthors = $('modeAuthors');
const includeCrypto = $('includeCrypto');

const ICON_PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>';
const ICON_STOP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

// Simple logging function
function log(message) {
    console.log(message);
}

// Toast message
let toastTimer = null;
function showMessage(text, type = 'info') {
    messageEl.textContent = text;
    messageEl.className = `${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        messageEl.className = type;
    }, 3000);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(date) {
    const secs = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

// Pairs waiting to be uploaded (the extension's local outbox)
function updatePairCount() {
    browserAPI.runtime.sendMessage({ type: 'GET_OUTBOX_COUNT' }).then(count => {
        statLocal.textContent = Number(count).toLocaleString();
        statLocal.classList.toggle('muted', count === 0);
    }).catch(() => {});
}

// Pull counts (numbers only, not the data) from Turso
function updateDbCount() {
    browserAPI.runtime.sendMessage({ type: 'GET_DB_COUNTS' }).then(res => {
        statDbPairs.textContent = res.pairs.toLocaleString();
        statDbTickers.textContent = res.tickers.toLocaleString();
        statDbPairs.classList.remove('muted');
        statDbTickers.classList.remove('muted');
    }).catch(err => {
        statDbPairs.textContent = '–';
        statDbTickers.textContent = '–';
        statDbPairs.classList.add('muted');
        statDbTickers.classList.add('muted');
        log(`DB count failed: ${err.message}`);
    });
}

function setConnection(state, text) {
    tursoStatus.className = `conn ${state}`;
    tursoStatus.lastElementChild.textContent = text;
}

function updateTursoStatus() {
    browserAPI.storage.local.get('tursoConfig').then(result => {
        if (result.tursoConfig) {
            const host = result.tursoConfig.url.replace(/^\w+:\/\//, '');
            setConnection('ok', host);
            if (!tursoUrlInput.value) tursoUrlInput.value = result.tursoConfig.url;
        } else {
            browserAPI.runtime.sendMessage({ type: 'GET_TURSO_FILE_HOST' }).then(host => {
                if (host) setConnection('ok', `${host} (turso-config.js)`);
                else setConnection('', 'Not configured');
            }).catch(() => setConnection('', 'Not configured'));
        }
    });
}

async function saveTursoCredentials(url, authToken) {
    saveTursoBtn.disabled = true;
    try {
        showMessage('Connecting to Turso...', 'info');
        const counts = await browserAPI.runtime.sendMessage({
            type: 'SAVE_TURSO_CONFIG',
            config: { url, authToken }
        });
        showMessage(`Connected. Database has ${counts.pairs.toLocaleString()} pairs`, 'success');
        tursoTokenInput.value = '';
        updateTursoStatus();
        updateDbCount();
    } catch (err) {
        log(`Saving Turso credentials failed: ${err.message}`);
        setConnection('bad', 'Connection failed');
        showMessage('Error: ' + err.message, 'error');
    } finally {
        saveTursoBtn.disabled = false;
    }
}

saveTursoBtn.addEventListener('click', () => {
    const url = tursoUrlInput.value.trim();
    const authToken = tursoTokenInput.value.trim();
    if (!url || !authToken) {
        showMessage('Enter both the database URL and the auth token', 'error');
        return;
    }
    saveTursoCredentials(url, authToken);
});

toggleTursoBtn.addEventListener('click', () => {
    const open = tursoSection.hidden;
    tursoSection.hidden = !open;
    toggleTursoBtn.setAttribute('aria-expanded', String(open));
});

clearTursoBtn.addEventListener('click', () => {
    if (confirm('Remove the saved Turso credentials?')) {
        browserAPI.storage.local.remove('tursoConfig').then(() => {
            tursoUrlInput.value = '';
            tursoTokenInput.value = '';
            showMessage('Credentials removed', 'success');
            updateTursoStatus();
            updateDbCount();
        });
    }
});

// Ranking mode: tickers or authors (both queried from Turso)
let rankMode = 'tickers';

function setRankMode(mode) {
    rankMode = mode;
    modeTickers.classList.toggle('active', mode === 'tickers');
    modeAuthors.classList.toggle('active', mode === 'authors');
    modeTickers.setAttribute('aria-pressed', String(mode === 'tickers'));
    modeAuthors.setAttribute('aria-pressed', String(mode === 'authors'));
}
modeTickers.addEventListener('click', () => setRankMode('tickers'));
modeAuthors.addEventListener('click', () => setRankMode('authors'));

function plural(n, word) {
    return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

showTopBtn.addEventListener('click', async () => {
    showTopBtn.disabled = true;
    try {
        const daysBack = parseInt(timeFilter.value);
        const isAuthors = rankMode === 'authors';
        const rows = await browserAPI.runtime.sendMessage({
            type: isAuthors ? 'GET_TOP_AUTHORS' : 'GET_TOP_MENTIONS',
            days: daysBack,
            includeCrypto: includeCrypto.checked
        });

        resultsPlaceholder.hidden = true;
        resultsDiv.hidden = false;

        if (rows.length === 0) {
            resultsMeta.textContent = '';
            resultsContent.innerHTML = '<div class="empty">Nothing found for the selected time range.</div>';
            return;
        }

        const timeRangeText = daysBack === 0 ? 'All time' : `Last ${daysBack} day${daysBack > 1 ? 's' : ''}`;
        resultsMeta.textContent = `${timeRangeText} \u00b7 top ${rows.length} ${isAuthors ? 'authors' : 'tickers'}${includeCrypto.checked ? '' : ' \u00b7 crypto excluded'}`;

        const maxCount = rows[0].count;
        resultsContent.innerHTML = rows.map((row, i) => {
            const latest = row.latest ? new Date(row.latest) : null;
            const latestStr = latest && !isNaN(latest) ? `Latest ${timeAgo(latest)}` : '';
            const detail = isAuthors ? plural(row.tickers, 'ticker') : plural(row.authors, 'author');
            const title = isAuthors ? `@${row.author}` : `$${row.ticker}`;
            const unit = isAuthors ? 'posts' : 'mentions';
            const width = Math.max(4, Math.round((row.count / maxCount) * 100));
            return `<div class="mention">
                <div class="mention-bar" style="width: ${width}%"></div>
                <div class="rank num">${i + 1}</div>
                <div class="m-main">
                    <span class="ticker-name">${escapeHtml(title)}</span>
                    <span class="mention-time" title="${latest ? escapeHtml(latest.toLocaleString()) : ''}">${escapeHtml(detail)}${latestStr ? ' \u00b7 ' + latestStr : ''}</span>
                </div>
                <div class="mention-count num">${row.count.toLocaleString()}<small>${unit}</small></div>
            </div>`;
        }).join('');

    } catch (err) {
        showMessage('Error: ' + err.message, 'error');
    } finally {
        showTopBtn.disabled = false;
    }
});

// Upload everything still pending to Turso
uploadBtn.addEventListener('click', () => {
    uploadBtn.disabled = true;
    showMessage('Syncing with Turso...', 'info');
    browserAPI.runtime.sendMessage({ type: 'SYNC_NOW' }).then(res => {
        showMessage(res.count === 0 ? 'Nothing to sync, all up to date' : `Synced ${res.count.toLocaleString()} pairs to Turso`, 'success');
        updatePairCount();
        updateDbCount();
    }).catch(err => {
        showMessage('Sync failed: ' + err.message, 'error');
    }).finally(() => {
        uploadBtn.disabled = false;
    });
});

// ---------- Collection deadline ----------
function localDateString(date = new Date()) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function formatDeadline(value) {
    return new Date(value + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function updateDeadlineHint() {
    deadlineHint.textContent = stopDateInput.value
        ? `Stops automatically once posts older than ${formatDeadline(stopDateInput.value)} appear.`
        : 'No deadline: scrolls until you stop it.';
}

stopDateInput.max = localDateString();
stopDateInput.addEventListener('change', () => {
    browserAPI.storage.local.set({ stopDate: stopDateInput.value || null });
    updateDeadlineHint();
});
clearDateBtn.addEventListener('click', () => {
    stopDateInput.value = '';
    browserAPI.storage.local.set({ stopDate: null });
    updateDeadlineHint();
});
browserAPI.storage.local.get('stopDate').then(result => {
    if (result.stopDate) stopDateInput.value = result.stopDate;
    updateDeadlineHint();
});

// Auto-scroll button functionality
let isAutoScrollActive = false;

// Update auto-scroll button and status pill to reflect current state
function setAutoScrollState(isScrolling) {
    isAutoScrollActive = isScrolling;
    autoScrollBtn.classList.toggle('running', isScrolling);
    autoScrollIcon.innerHTML = isScrolling ? ICON_STOP : ICON_PLAY;
    autoScrollLabel.textContent = isScrolling ? 'Stop Auto-Scroll' : 'Start Auto-Scroll';
    scrollStatus.classList.toggle('running', isScrolling);
    scrollStatusText.textContent = isScrolling ? 'Scrolling' : 'Idle';
}

async function updateAutoScrollButton() {
    try {
        const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0) return;

        const response = await browserAPI.tabs.sendMessage(tabs[0].id, { type: 'GET_AUTO_SCROLL_STATUS' });
        setAutoScrollState(response && response.isScrolling);
    } catch (err) {
        console.log('Could not get auto-scroll status:', err.message);
        setAutoScrollState(false);
    }
}

autoScrollBtn.addEventListener('click', async () => {
    try {
        // Query the active tab
        const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0) {
            showMessage('No active tab found', 'error');
            return;
        }

        const tab = tabs[0];

        // Check if we're on x.com
        if (!tab.url || !tab.url.includes('x.com')) {
            showMessage('Please navigate to x.com first', 'error');
            return;
        }

        if (isAutoScrollActive) {
            await browserAPI.tabs.sendMessage(tab.id, { type: 'STOP_AUTO_SCROLL' });
            setAutoScrollState(false);
        } else {
            const res = await browserAPI.tabs.sendMessage(tab.id, {
                type: 'START_AUTO_SCROLL',
                stopDate: stopDateInput.value || null
            });
            if (res && res.ok === false) {
                showMessage(res.error, 'error');
                return;
            }
            setAutoScrollState(true);
        }
    } catch (err) {
        console.log('Error toggling auto-scroll:', err);
        showMessage('Error: Make sure you are on x.com', 'error');
    }
});

// Listen for auto-scroll status updates from content script
browserAPI.runtime.onMessage.addListener((message) => {
    if (message.type === 'AUTO_SCROLL_STATUS') {
        setAutoScrollState(message.isScrolling);
        if (!message.isScrolling && message.reason === 'deadline') {
            showMessage(`Reached ${formatDeadline(message.deadline)}. Collection complete`, 'success');
            updatePairCount();
            updateDbCount();
        }
    }
});

// Keep the unsynced count live while the popup is open
browserAPI.storage.onChanged.addListener(changes => {
    if (changes.outbox) {
        updatePairCount();
    }
});

// Initial load
setAutoScrollState(false);
updatePairCount();
updateDbCount();
updateTursoStatus();
updateAutoScrollButton();
