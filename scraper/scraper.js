// X Stock Ticker Scraper (Playwright)
// Same logic as the browser extension, but runs as an authenticated Playwright session
// on the "Following" timeline only, and writes to the same Turso table.
//
//   npm start -- [--since 2026-09-01] [--speed 1.5]
//
//   --since DATE   stop once posts older than DATE (UTC) appear
//   --speed N      scroll speed multiplier (1 = same cadence as the extension; default 1)
//
// Stop with Ctrl+C; pending pairs are saved to Turso on exit.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { tursoEnsureSchema, tursoUploadPairs, tursoCounts } = require('../turso.js');

const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const TURSO_FILE = path.join(__dirname, 'turso.json');

const argValue = name => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
};
const SINCE = argValue('--since') ? new Date(argValue('--since') + 'T00:00:00Z') : null;
const SPEED = Math.max(0.25, Math.min(Number(argValue('--speed')) || 1, 4));

const FLUSH_EVERY = 20;          // pairs
const FLUSH_INTERVAL = 30000;    // ms, bounds how much a hard kill can lose
const STUCK_TIMEOUT = 6000;      // ms without progress before recovering
const RECOVERY_POSTS = 15;       // how many posts to scroll back up when stuck
const MAX_PAGE_RESTARTS = 5;
const MAX_STUCK_RECOVERIES_IN_A_ROW = 6;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min)) + min;

// ---------- Page snapshot (runs inside the page; extraction logic ported from content.js) ----------
function snapshotInPage() {
    function isRepostOrReply(article) {
        const repostedIndicator = article.querySelector('[data-testid="socialContext"]');
        if (repostedIndicator) {
            const text = repostedIndicator.textContent.toLowerCase();
            if (text.includes('reposted') || text.includes('repost')) return true;
        }
        if (article.textContent.includes('Replying to @')) return true;
        return false;
    }

    function normalizeStatusUrl(href) {
        let url = href.startsWith('http') ? href : 'https://x.com' + href;
        url = url.split('?')[0];
        url = url.replace(/\/(photo|video|analytics|likes|retweets)\/\d+$/, '');
        url = url.replace(/\/(photo|video|analytics)$/, '');
        return url;
    }

    const pairs = [];
    document.querySelectorAll('a[href*="=%24"]').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || !href.includes('q=%24')) return;
        const tickerMatch = href.match(/q=%24([A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*)/i);
        if (!tickerMatch) return;
        const ticker = tickerMatch[1].toUpperCase();

        const article = link.closest('article');
        if (!article || isRepostOrReply(article)) return;

        const statusLink = article.querySelector('a[href*="/status/"]');
        if (!statusLink) return;
        const url = normalizeStatusUrl(statusLink.getAttribute('href'));

        const timeElement = article.querySelector('time[datetime]');
        const timestamp = timeElement ? timeElement.getAttribute('datetime') : new Date().toISOString();

        pairs.push({ ticker, url, timestamp });
    });

    // Every post in view (not only ticker posts): used for stuck detection and end-of-range detection
    const articles = Array.from(document.querySelectorAll('article'));
    const keys = [];
    const times = [];
    let heightSum = 0;
    articles.forEach(article => {
        heightSum += article.getBoundingClientRect().height;
        const link = article.querySelector('a[href*="/status/"]');
        if (link) keys.push(link.getAttribute('href'));
        // Reposts show the original (possibly old) timestamp, so only use original posts for the date check
        if (!article.querySelector('[data-testid="socialContext"]')) {
            const t = article.querySelector('time[datetime]');
            if (t) times.push(t.getAttribute('datetime'));
        }
    });

    return {
        pairs,
        keys,
        times,
        y: window.scrollY,
        avgHeight: articles.length ? heightSum / articles.length : 300
    };
}

// ---------- Turso storage ----------
let tursoConfig = null;
let pending = [];
let flushChain = Promise.resolve();
let lastFlushAt = Date.now();

async function initDb() {
    if (!fs.existsSync(TURSO_FILE)) {
        throw new Error(`Missing ${TURSO_FILE} ({"url": "libsql://...", "auth_token": "..."})`);
    }
    const cfg = JSON.parse(fs.readFileSync(TURSO_FILE, 'utf8'));
    tursoConfig = { url: cfg.url, authToken: cfg.auth_token };
    await tursoEnsureSchema(tursoConfig);
    const counts = await tursoCounts(tursoConfig);
    console.log(`Connected to Turso. ${counts.pairs.toLocaleString()} pairs, ${counts.tickers.toLocaleString()} tickers already stored.`);
}

// Serialized; INSERT OR IGNORE makes repeated/overlapping runs duplicate-safe
function flush() {
    flushChain = flushChain.then(async () => {
        lastFlushAt = Date.now();
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        try {
            await tursoUploadPairs(tursoConfig, batch, 'scraper');
            console.log(`Saved ${batch.length} pairs to Turso`);
        } catch (err) {
            pending = batch.concat(pending); // retry on the next flush
            console.error('Turso write failed, will retry:', err.message);
        }
    });
    return flushChain;
}

const seenPairs = new Set();
function addPairs(pairs) {
    for (const p of pairs) {
        const key = `${p.ticker}|${p.url}`;
        if (!seenPairs.has(key)) {
            seenPairs.add(key);
            pending.push(p);
            console.log(`+ $${p.ticker} ${p.url}`);
        }
    }
    if (pending.length >= FLUSH_EVERY || (pending.length > 0 && Date.now() - lastFlushAt > FLUSH_INTERVAL)) {
        flush();
    }
}

// ---------- Auth ----------
// cookies.json: {"auth_token": "...", "ct0": "..."} copied from your logged-in Firefox
function loadCookies() {
    if (!fs.existsSync(COOKIES_FILE)) {
        throw new Error(`Missing ${COOKIES_FILE}. Copy cookies.example.json to cookies.json and fill in auth_token and ct0.`);
    }
    const c = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    if (!c.auth_token || !c.ct0) throw new Error('cookies.json needs "auth_token" and "ct0"');
    return Object.entries(c).map(([name, value]) => ({
        name, value, domain: '.x.com', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'None',
    }));
}

async function isLoggedIn(page) {
    try {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="primaryColumn"] article, [data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 15000 });
        return !page.url().includes('/login') && !page.url().includes('/i/flow');
    } catch {
        return false;
    }
}

// ---------- Following tab ----------
async function selectFollowingTab(page) {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    const tab = page.getByRole('tab', { name: 'Following', exact: true });
    await tab.waitFor({ timeout: 20000 });
    await tab.click();
    await page.waitForFunction(() => {
        const t = [...document.querySelectorAll('[role="tab"]')].find(e => e.textContent.trim() === 'Following');
        return t && t.getAttribute('aria-selected') === 'true';
    }, null, { timeout: 10000 });
    await page.waitForSelector('article', { timeout: 20000 });
    await page.mouse.move(640, 450);
    console.log('On the Following timeline.');
}

// Same mechanism as content.js: native smooth scrollBy inside the page
function smoothScroll(page, distance) {
    return page.evaluate(d => window.scrollBy({ top: d, behavior: 'smooth' }), distance);
}

const isPageGone = err => /crash|closed|destroyed|Target/i.test(err.message);

// ---------- Main ----------
(async () => {
    await initDb();

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies(loadCookies());
    // We only need text and links: block images/video/fonts to keep the page light
    await context.route('**/*', route =>
        ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
    let page = await context.newPage();

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        console.log('\nStopping...');
        await flush();
        await browser.close().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    if (!(await isLoggedIn(page))) {
        throw new Error('Cookies rejected (not logged in). Re-copy auth_token and ct0 from Firefox; they expire if you log out.');
    }
    console.log(`Logged in via cookies. Speed x${SPEED}${SINCE ? `, collecting back to ${SINCE.toISOString().slice(0, 10)}` : ''}.`);
    await selectFollowingTab(page);

    // Progress tracking (stuck detection)
    const seenArticles = new Set();
    let lastProgressAt = Date.now();
    let lastProgressY = 0;
    let stuckInARow = 0;
    let pageRestarts = 0;

    const resetProgress = (y = 0) => {
        lastProgressAt = Date.now();
        lastProgressY = y;
    };

    // X sometimes stops loading new posts; scroll back up ~15 posts, then continue down
    async function recoverFromStuck(snap) {
        stuckInARow++;
        console.log(`Page stuck (${stuckInARow}), scrolling back up ~${RECOVERY_POSTS} posts...`);
        const total = Math.max(RECOVERY_POSTS * snap.avgHeight * 1.2, 3000);
        let done = 0;
        while (done < total && !stopping) {
            const step = Math.min(700, total - done);
            await smoothScroll(page, -step);
            done += step;
            await sleep(rand(400, 700));
        }
        await sleep(1500);
        const y = await page.evaluate(() => window.scrollY);
        resetProgress(y);
    }

    // The page occasionally crashes; reopen it and continue (the timeline restarts at the top)
    async function restartPage() {
        pageRestarts++;
        if (pageRestarts > MAX_PAGE_RESTARTS) throw new Error(`Page crashed ${MAX_PAGE_RESTARTS} times, giving up`);
        console.log(`Page crashed or closed, reopening (${pageRestarts}/${MAX_PAGE_RESTARTS})...`);
        await flush();
        await page.close().catch(() => {});
        page = await context.newPage();
        await selectFollowingTab(page);
        seenArticles.clear();
        resetProgress(0);
    }

    // Human-like pacing
    let nextBreakAt = Date.now() + rand(180000, 300000);     // short break every 3-5 min
    let nextLongBreakAt = Date.now() + rand(600000, 900000); // long break every 10-15 min
    let stepCount = 0;
    let idleSteps = 0;
    let oldPosts = 0;
    let lastNewPairAt = Date.now();

    while (!stopping) {
        let snap;
        try {
            snap = await page.evaluate(snapshotInPage);
        } catch (err) {
            if (!isPageGone(err)) throw err;
            await restartPage();
            continue;
        }

        const before = seenPairs.size;
        addPairs(snap.pairs);
        const gotNewPair = seenPairs.size > before;
        if (gotNewPair) lastNewPairAt = Date.now();
        idleSteps = gotNewPair ? 0 : idleSteps + 1;

        // Progress = a new post appeared, or we moved further down the page
        let progressed = false;
        for (const key of snap.keys) {
            if (!seenArticles.has(key)) {
                seenArticles.add(key);
                progressed = true;
            }
        }
        if (snap.y >= lastProgressY + 100) {
            lastProgressY = snap.y;
            progressed = true;
        }
        if (progressed) {
            lastProgressAt = Date.now();
            stuckInARow = 0;
        }

        if (++stepCount % 20 === 0) {
            const newest = snap.times[0] || '-';
            console.log(`[step ${stepCount}] new pairs this run=${seenPairs.size} scrollY=${Math.round(snap.y)} posts in view=${snap.keys.length} newest in view=${newest}`);
        }

        // End of the target range: any original posts older than --since
        if (SINCE) {
            oldPosts += snap.times.filter(t => new Date(t) < SINCE).length;
            if (oldPosts >= 3) {
                console.log(`Reached posts older than ${SINCE.toISOString().slice(0, 10)}. Done.`);
                break;
            }
        }
        if (Date.now() - lastNewPairAt > 10 * 60 * 1000) {
            console.log('No new pairs for 10 minutes (end of timeline or rate limited). Stopping.');
            break;
        }

        // Stuck page: recover instead of scrolling harder
        if (Date.now() - lastProgressAt > STUCK_TIMEOUT) {
            if (stuckInARow >= MAX_STUCK_RECOVERIES_IN_A_ROW) {
                console.log('Page keeps getting stuck after recovery. Stopping.');
                break;
            }
            try {
                await recoverFromStuck(snap);
            } catch (err) {
                if (!isPageGone(err)) throw err;
                await restartPage();
            }
            continue;
        }

        try {
            // Occasionally scroll back up a little, like a person re-reading
            if (Math.random() < 0.08) {
                await smoothScroll(page, -rand(150, 350));
                await sleep(rand(800, 2000) / SPEED);
            }
            await smoothScroll(page, rand(300, 400));
        } catch (err) {
            if (!isPageGone(err)) throw err;
            await restartPage();
            continue;
        }

        // Same delay range as content.js (200-1100ms), divided by --speed
        let delay = rand(200, 1100) / SPEED;
        if (Math.random() < 0.05) delay += rand(800, 2000);      // linger on a post
        if (idleSteps >= 3) delay += Math.min(idleSteps, 10) * 1000; // give the page time to load more
        await sleep(delay);

        if (Date.now() > nextLongBreakAt) {
            const t = rand(4000, 8000);
            console.log(`Long break ${Math.round(t / 1000)}s...`);
            await sleep(t);
            nextLongBreakAt = Date.now() + rand(600000, 900000);
            nextBreakAt = Date.now() + rand(180000, 300000);
            resetProgress(lastProgressY);
        } else if (Date.now() > nextBreakAt) {
            const t = rand(1000, 3000);
            console.log(`Break ${Math.round(t / 1000)}s...`);
            await sleep(t);
            nextBreakAt = Date.now() + rand(180000, 300000);
            resetProgress(lastProgressY);
        }
    }
    await shutdown();
})().catch(async err => {
    console.error('Fatal:', err.message);
    await flush().catch(() => {});
    process.exit(1);
});
