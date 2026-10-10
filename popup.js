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
const catchUpBtn = $('catchUpBtn');
const fillGapBtn = $('fillGapBtn');
const covRange = $('covRange');
const covSub = $('covSub');
const deadlineHint = $('deadlineHint');
const uniquePerDay = $('uniquePerDay');

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

// What the database already holds, so you know what to target
const shortDate = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const shortDateTime = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// 'YYYY-MM-DD' (a UTC day from the database) -> 'Oct 5'
const dayLabel = day => new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function updateCoverage() {
    return browserAPI.runtime.sendMessage({ type: 'GET_COVERAGE' }).then(cov => {
        covSub.classList.remove('warn');
        const fillable = !!cov.fillFrom;
        fillGapBtn.disabled = !fillable;
        fillGapBtn.title = fillable
            ? 'Start scrolling and stop once the oldest fillable gap is filled'
            : (cov.gaps && cov.gaps.length ? 'The remaining gaps are older than the feed reaches' : 'No gaps to fill');
        if (!cov.fromDay) {
            covRange.textContent = 'Nothing yet';
            covRange.classList.add('muted');
            covSub.textContent = `No day has ${cov.minPosts}+ posts yet.`;
            return cov;
        }
        covRange.classList.remove('muted');
        covRange.textContent = cov.fromDay === cov.toDay ? dayLabel(cov.fromDay) : `${dayLabel(cov.fromDay)} \u2192 ${dayLabel(cov.toDay)}`;

        let html = `${cov.coveredDays} day${cov.coveredDays === 1 ? '' : 's'} with ${cov.minPosts}+ posts`
            + ` \u00b7 last collected post <b>${escapeHtml(timeAgo(new Date(cov.to)))}</b>`;
        if (cov.gaps.length > 0) {
            const label = g => {
                const days = g.fromDay === g.toDay ? dayLabel(g.fromDay) : `${dayLabel(g.fromDay)}\u2013${dayLabel(g.toDay)}`;
                const note = g.includesToday ? ` (today${g.posts ? `, ${g.posts} so far` : ''})` : '';
                return g.unreachable ? `<span class="old">${escapeHtml(days)} (too old to fill)</span>` : escapeHtml(days + note);
            };
            const parts = cov.gaps.slice(-6).map(label);
            const more = cov.gaps.length > 6 ? `${cov.gaps.length - 6} older, ` : '';
            html += `<div class="cov-missing">Missing ${cov.missing.length} day${cov.missing.length === 1 ? '' : 's'}: ${more}${parts.join(', ')}</div>`;
        } else {
            html += `<div class="cov-ok">No gaps</div>`;
        }
        html += `<div class="cov-edge">Nothing complete before ${escapeHtml(dayLabel(cov.fromDay))}</div>`;
        covSub.innerHTML = html;
        return cov;
    }).catch(err => {
        covRange.textContent = '\u2013';
        covRange.classList.add('muted');
        covSub.textContent = 'Unavailable';
        log(`Coverage failed: ${err.message}`);
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
        updateCoverage();
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

function plural(n, word) {
    return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

// Remember the counting preference (default: one per author per day)
browserAPI.storage.local.get('uniquePerDay').then(result => {
    if (result.uniquePerDay === false) uniquePerDay.checked = false;
});
uniquePerDay.addEventListener('change', () => browserAPI.storage.local.set({ uniquePerDay: uniquePerDay.checked }));

showTopBtn.addEventListener('click', async () => {
    showTopBtn.disabled = true;
    try {
        const daysBack = parseInt(timeFilter.value);
        const rows = await browserAPI.runtime.sendMessage({
            type: 'GET_TOP_MENTIONS',
            days: daysBack,
            unique: uniquePerDay.checked
        });

        resultsPlaceholder.hidden = true;
        resultsDiv.hidden = false;

        if (rows.length === 0) {
            resultsMeta.textContent = '';
            resultsContent.innerHTML = '<div class="empty">Nothing found for the selected time range.</div>';
            return;
        }

        const timeRangeText = daysBack === 0 ? 'All time' : `Last ${daysBack} day${daysBack > 1 ? 's' : ''}`;
        resultsMeta.textContent = `${timeRangeText} \u00b7 top ${rows.length} tickers${uniquePerDay.checked ? ' \u00b7 one per author per day' : ''}`;

        const maxCount = rows[0].count;
        resultsContent.innerHTML = rows.map((row, i) => {
            const latest = row.latest ? new Date(row.latest) : null;
            const latestStr = latest && !isNaN(latest) ? `Latest ${timeAgo(latest)}` : '';
            const collapsed = uniquePerDay.checked && row.raw > row.count;
            const detail = plural(row.authors, 'author') + (collapsed ? ` \u00b7 ${row.raw.toLocaleString()} raw` : '');
            const title = `$${row.ticker}`;
            const unit = 'mentions';
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
        updateCoverage();
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
    if (value.includes('T')) {
        return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    return new Date(value + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

let stopAt = null; // exact catch-up deadline (ISO timestamp); cleared when the date is edited by hand

function updateDeadlineHint() {
    if (stopAt) {
        deadlineHint.textContent = `Catch-up: stops once posts older than ${formatDeadline(stopAt)} appear.`;
        return;
    }
    deadlineHint.textContent = stopDateInput.value
        ? `Stops automatically once posts older than ${formatDeadline(stopDateInput.value)} appear.`
        : 'No deadline: scrolls until you stop it.';
}

stopDateInput.max = localDateString();
stopDateInput.addEventListener('change', e => {
    if (e.isTrusted) stopAt = null; // edited by hand: use the plain date
    browserAPI.storage.local.set({ stopDate: stopDateInput.value || null, stopAt });
    updateDeadlineHint();
});
clearDateBtn.addEventListener('click', () => {
    stopDateInput.value = '';
    stopAt = null;
    browserAPI.storage.local.set({ stopDate: null, stopAt: null });
    updateDeadlineHint();
});
// Catch up: stop at the newest post already in the database, minus 2 hours of overlap
catchUpBtn.addEventListener('click', async () => {
    catchUpBtn.disabled = true;
    try {
        const cov = await browserAPI.runtime.sendMessage({ type: 'GET_COVERAGE' });
        if (!cov.catchUpFrom) {
            showMessage(`No day has ${cov.minPosts}+ posts yet, nothing to catch up to`, 'error');
            return;
        }
        // Anchor: end of the last fully collected day before the most recent gap, minus 2h overlap
        const target = new Date(new Date(cov.catchUpFrom).getTime() - 2 * 3600 * 1000);
        stopAt = target.toISOString();
        stopDateInput.value = localDateString(target);
        stopDateInput.dispatchEvent(new Event('change')); // saves it and updates the hint (keeps stopAt: not user-typed)
        showMessage(`Catch-up set: stops at ${formatDeadline(stopAt)}`, 'success');
    } catch (err) {
        showMessage('Error: ' + err.message, 'error');
    } finally {
        catchUpBtn.disabled = false;
    }
});

browserAPI.storage.local.get(['stopDate', 'stopAt']).then(result => {
    if (result.stopDate) stopDateInput.value = result.stopDate;
    stopAt = result.stopDate ? result.stopAt || null : null;
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

// Start auto-scroll on the active x.com tab with the current deadline; returns true when it started
async function startScrolling(extra = {}) {
    try {
        const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0) {
            showMessage('No active tab found', 'error');
            return false;
        }

        const tab = tabs[0];
        if (!tab.url || !tab.url.includes('x.com')) {
            showMessage('Please navigate to x.com first', 'error');
            return false;
        }

        const res = await browserAPI.tabs.sendMessage(tab.id, {
            type: 'START_AUTO_SCROLL',
            stopDate: stopAt || stopDateInput.value || null,
            ...extra
        });
        if (res && res.ok === false) {
            showMessage(res.error, 'error');
            return false;
        }
        setAutoScrollState(true);
        return true;
    } catch (err) {
        console.log('Error starting auto-scroll:', err);
        showMessage('Error: Make sure you are on x.com', 'error');
        return false;
    }
}

autoScrollBtn.addEventListener('click', async () => {
    if (!isAutoScrollActive) {
        await startScrolling();
        return;
    }
    try {
        const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await browserAPI.tabs.sendMessage(tabs[0].id, { type: 'STOP_AUTO_SCROLL' });
        }
        setAutoScrollState(false);
    } catch (err) {
        console.log('Error stopping auto-scroll:', err);
        showMessage('Error: Make sure you are on x.com', 'error');
    }
});

// Fill gaps: scroll through the posts the database does not have and stop once it reaches posts it
// already has. The date of the oldest fillable gap stays as a safety net.
fillGapBtn.addEventListener('click', async () => {
    if (isAutoScrollActive) {
        showMessage('Already scrolling. Stop it first, then press Fill gaps', 'error');
        return;
    }
    fillGapBtn.disabled = true;
    try {
        const cov = await browserAPI.runtime.sendMessage({ type: 'GET_COVERAGE' });
        if (!cov.fillFrom) {
            showMessage(cov.gaps && cov.gaps.length ? 'The remaining gaps are older than the feed reaches' : 'No gaps to fill', 'info');
            return;
        }
        const target = new Date(new Date(cov.fillFrom).getTime() - 2 * 3600 * 1000);
        stopAt = target.toISOString();
        stopDateInput.value = localDateString(target);
        stopDateInput.dispatchEvent(new Event('change')); // saves it and updates the hint

        // Upload anything pending first, then take Turso's clock: posts inserted after it do not count as known
        await browserAPI.runtime.sendMessage({ type: 'SYNC_NOW' }).catch(() => {});
        const runStart = await browserAPI.runtime.sendMessage({ type: 'GET_SERVER_TIME' });
        const gaps = cov.gaps.filter(g => !g.unreachable).map(g => ({ fromDay: g.fromDay, toDay: g.toDay }));

        const started = await startScrolling({ knownStop: { runStart, gaps, minKnown: 6 } });
        if (started) showMessage('Filling gaps: scrolls until it reaches posts already in the database', 'success');
    } catch (err) {
        showMessage('Error: ' + err.message, 'error');
    } finally {
        updateCoverage(); // re-enables the button when there is still something to fill
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
            updateCoverage();
        } else if (!message.isScrolling && message.reason === 'known') {
            showMessage('Gap filled. Reached posts already in the database', 'success');
            updatePairCount();
            updateDbCount();
            updateCoverage();
        } else if (!message.isScrolling && message.reason === 'end-of-feed') {
            const where = message.oldest ? ` at ${shortDateTime(message.oldest)}` : '';
            showMessage(`Feed ended${where}. X is not loading older posts`, 'error');
            updatePairCount();
            updateDbCount();
            updateCoverage();
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
updateCoverage();
updateTursoStatus();
updateAutoScrollButton();
