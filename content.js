// Twitter Stock Ticker Extractor - Content Script
// Runs on x.com pages and extracts ticker-post pairs

// Browser API compatibility for Firefox
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const seenPairs = new Set(); // Track unique ticker-post combinations
let updateTimer = null;

// Check if article is a repost or reply
function isRepostOrReply(article) {
    // Check for "Reposted" text indicator
    const repostedIndicator = article.querySelector('[data-testid="socialContext"]');
    if (repostedIndicator) {
        const text = repostedIndicator.textContent.toLowerCase();
        if (text.includes('reposted') || text.includes('repost')) {
            return true;
        }
    }

    // Check for "Replying to" indicator
    const replyIndicator = article.textContent;
    if (replyIndicator.includes('Replying to @')) {
        return true;
    }

    return false;
}

// Normalize a status link href to a clean absolute URL
function normalizeStatusUrl(href) {
    let url = href.startsWith('http') ? href : 'https://x.com' + href;
    url = url.split('?')[0];
    url = url.replace(/\/(photo|video|analytics|likes|retweets)\/\d+$/, '');
    url = url.replace(/\/(photo|video|analytics)$/, '');
    return url;
}

// Function to extract ticker-post pairs from the current DOM
function extractTickerPairs() {
    const pairs = [];

    // Find all links containing =%24 (URL-encoded $)
    const allLinks = document.querySelectorAll('a[href*="=%24"]');

    allLinks.forEach(link => {
        const href = link.getAttribute('href');

        // Extract ticker from URL like /search?q=%24OSCR
        if (href && href.includes('q=%24')) {
            const tickerMatch = href.match(/q=%24([A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*)/i);
            if (tickerMatch) {
                const ticker = tickerMatch[1].toUpperCase();

                // Find the closest article (tweet container)
                const article = link.closest('article');
                if (article) {
                    // Skip reposts and replies
                    if (isRepostOrReply(article)) {
                        return; // Skip this one
                    }
                    // Find the status link in this article
                    const statusLink = article.querySelector('a[href*="/status/"]');
                    if (statusLink) {
                        const statusHref = statusLink.getAttribute('href');
                        const fullUrl = normalizeStatusUrl(statusHref);

                        // Extract timestamp from <time> element
                        const timeElement = article.querySelector('time[datetime]');
                        const timestamp = timeElement ? timeElement.getAttribute('datetime') : new Date().toISOString();

                        // Create unique pair identifier
                        const pairKey = `${ticker}|${fullUrl}`;

                        // Only add if we haven't seen this combination before
                        if (!seenPairs.has(pairKey)) {
                            seenPairs.add(pairKey);
                            pairs.push({
                                ticker: ticker,
                                url: fullUrl,
                                timestamp: timestamp
                            });
                        }
                    }
                }
            }
        }
    });

    return pairs;
}

// Function to send new pairs to background script
function sendNewPairs(pairs) {
    if (pairs.length > 0) {
        browserAPI.runtime.sendMessage({
            type: 'NEW_TICKER_PAIRS',
            pairs: pairs
        }).catch(err => {
            console.log('Extension context invalidated, reloading...');
        });
    }
}

// Observe DOM changes (for dynamic content loading during scroll)
const observer = new MutationObserver(() => {
    // Debounce: wait 500ms after last change before extracting
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
        const newPairs = extractTickerPairs();
        sendNewPairs(newPairs);
    }, 500);
});

// Start observing when page loads
function startObserving() {
    // Initial extraction
    const initialPairs = extractTickerPairs();
    sendNewPairs(initialPairs);

    // Observe future changes
    const targetNode = document.body;
    if (targetNode) {
        observer.observe(targetNode, {
            childList: true,
            subtree: true
        });
        console.log('Twitter Ticker Extractor: Active and monitoring...');
    }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
} else {
    startObserving();
}

// Auto-scroll functionality
let isAutoScrolling = false;
let autoScrollInterval = null;

// --- Stuck-page detection ---
// X sometimes stops loading new posts. If nothing new shows up for STUCK_TIMEOUT ms,
// scroll back up RECOVERY_POSTS posts and then continue scrolling down.
const STUCK_TIMEOUT = 6000;
const RECOVERY_POSTS = 15;
const seenArticles = new Set(); // every post seen (not only ticker posts)
let lastProgressAt = Date.now();
let lastProgressY = 0;
let isRecovering = false;
let stuckInARow = 0;        // recoveries in a row that found no new post
const MAX_STUCK_IN_A_ROW = 4; // after this many, assume X stopped serving older posts
let oldestSeen = null;      // oldest original post seen this run (ISO string)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Progress = a new post appeared, or we moved further down the page
function checkProgress() {
    let progressed = false;
    document.querySelectorAll('article').forEach(article => {
        const link = article.querySelector('a[href*="/status/"]');
        if (!link) return;
        const key = link.getAttribute('href');
        if (!seenArticles.has(key)) {
            seenArticles.add(key);
            progressed = true;
            stuckInARow = 0; // genuinely new content, so the feed has not ended
        }
    });
    if (window.scrollY >= lastProgressY + 100) {
        progressed = true;
        lastProgressY = window.scrollY;
    }
    if (progressed) lastProgressAt = Date.now();
}

function resetProgress() {
    lastProgressAt = Date.now();
    lastProgressY = window.scrollY;
}

async function recoverFromStuck() {
    stuckInARow++;
    if (stuckInARow > MAX_STUCK_IN_A_ROW) {
        // Scrolling up and down did not bring new posts: X is not serving anything older
        console.log('Twitter Ticker Extractor: feed ended, stopping');
        sendNewPairs(extractTickerPairs());
        stopAutoScroll('end-of-feed');
        return;
    }
    isRecovering = true;
    console.log('Twitter Ticker Extractor: page stuck, scrolling up to recover...');

    // Distance of ~RECOVERY_POSTS posts, based on the average height of visible posts
    const articles = Array.from(document.querySelectorAll('article'));
    const avgHeight = articles.length
        ? articles.reduce((sum, a) => sum + a.getBoundingClientRect().height, 0) / articles.length
        : 300;
    const total = Math.max(RECOVERY_POSTS * avgHeight * 1.2, 3000);

    let done = 0;
    while (done < total && isAutoScrolling && window.scrollY > 0) {
        const step = Math.min(700, total - done);
        window.scrollBy({ top: -step, behavior: 'smooth' });
        done += step;
        await sleep(400 + Math.floor(Math.random() * 300));
    }
    await sleep(1500); // let the page settle

    resetProgress();
    isRecovering = false;
    if (isAutoScrolling) humanLikeScroll();
}

// --- Collection deadline ---
// "Collect back to" a chosen date: once posts older than it show up, stop and hand everything over.
let deadlineDate = null;          // 'YYYY-MM-DD' chosen in the popup (local time)
let deadline = null;              // Date at local midnight of that day
const oldPostKeys = new Set();    // distinct original posts seen that are older than the deadline
const DEADLINE_CONFIRMATIONS = 3; // need a few, so one stray old post cannot end the run early

function checkDeadline() {
    document.querySelectorAll('article').forEach(article => {
        // Reposts show the original post's time, so only original posts count
        if (article.querySelector('[data-testid="socialContext"]')) return;
        const time = article.querySelector('time[datetime]');
        const link = article.querySelector('a[href*="/status/"]');
        if (!time || !link) return;
        const iso = time.getAttribute('datetime');
        if (!oldestSeen || iso < oldestSeen) oldestSeen = iso;
        if (deadline && new Date(iso) < deadline) {
            oldPostKeys.add(link.getAttribute('href'));
        }
    });
    return !!deadline && oldPostKeys.size >= DEADLINE_CONFIRMATIONS;
}

// The deadline logic assumes a chronological feed, so on the home page require the Following tab
function isFollowingTabSelected() {
    const tab = Array.from(document.querySelectorAll('[role="tab"]'))
        .find(t => t.textContent.trim() === 'Following');
    return !!tab && tab.getAttribute('aria-selected') === 'true';
}

// --- Known-post stop ("Fill gaps") ---
// Scroll through posts the database does not have and stop once it reaches posts it already has.
// The feed is chronological, so cashtag posts are judged in the order they first appear:
//  - known posts at the very top are ignored (a few top posts are collected just by loading the page)
//  - after unknown posts have been seen, `minKnown` known posts in a row mean we are back in collected data
//  - if the coverage still lists older gaps, keep going; otherwise stop
let knownStop = null;            // { runStart, gaps: [{fromDay, toDay}], minKnown }
const knownJudged = new Set();   // post urls already queued for a database check
let knownQueue = [];             // [{url, ts}] in feed order, waiting for the check
let knownProcessing = false;
let knownStopReached = false;
let sawUnknown = false;
let knownRun = 0;

// Original cashtag posts currently in the DOM, in feed order (one entry per post)
function listCashtagPosts() {
    const posts = [];
    const urls = new Set();
    document.querySelectorAll('a[href*="=%24"]').forEach(link => {
        if (!(link.getAttribute('href') || '').includes('q=%24')) return;
        const article = link.closest('article');
        if (!article || isRepostOrReply(article)) return;
        const statusLink = article.querySelector('a[href*="/status/"]');
        const time = article.querySelector('time[datetime]');
        if (!statusLink || !time) return;
        const url = normalizeStatusUrl(statusLink.getAttribute('href'));
        if (urls.has(url)) return;
        urls.add(url);
        posts.push({ url, ts: time.getAttribute('datetime') });
    });
    return posts;
}

// True when the coverage lists a gap that includes this post's day or is older than it
function gapsRemainBelow(ts) {
    const day = ts.slice(0, 10);
    return knownStop.gaps.some(gap => gap.fromDay <= day);
}

function queueKnownPosts() {
    if (!knownStop) return;
    for (const post of listCashtagPosts()) {
        if (!knownJudged.has(post.url)) {
            knownJudged.add(post.url);
            knownQueue.push(post);
        }
    }
    processKnownQueue();
}

async function processKnownQueue() {
    if (knownProcessing || !knownStop || knownQueue.length === 0) return;
    knownProcessing = true;
    try {
        while (knownQueue.length > 0 && isAutoScrolling && !knownStopReached) {
            const batch = knownQueue.slice(0, 50);
            const known = new Set(await browserAPI.runtime.sendMessage({
                type: 'CHECK_KNOWN',
                urls: batch.map(post => post.url),
                before: knownStop.runStart
            }));
            knownQueue.splice(0, batch.length); // only after a successful check, so a failure retries
            for (const post of batch) {
                if (known.has(post.url)) {
                    knownRun++;
                } else {
                    knownRun = 0;
                    sawUnknown = true;
                }
                if (sawUnknown && knownRun >= knownStop.minKnown) {
                    if (gapsRemainBelow(post.ts)) {
                        sawUnknown = false; // left one gap, an older one is still below
                        knownRun = 0;
                    } else {
                        knownStopReached = true;
                        break;
                    }
                }
            }
        }
    } catch (err) {
        console.log('Twitter Ticker Extractor: known-post check failed, will retry:', err.message);
    } finally {
        knownProcessing = false;
    }
    if (knownStopReached && isAutoScrolling) {
        console.log('Twitter Ticker Extractor: reached posts already in the database, stopping');
        sendNewPairs(extractTickerPairs());
        stopAutoScroll('known');
    }
}

// Human-like scroll function
function humanLikeScroll() {
    if (!isAutoScrolling || isRecovering) return;

    checkProgress();
    queueKnownPosts();
    if (checkDeadline()) {
        console.log(`Twitter Ticker Extractor: reached posts older than ${deadlineDate}, stopping`);
        // Extract the last posts on screen before stopping (extraction is debounced)
        sendNewPairs(extractTickerPairs());
        stopAutoScroll('deadline');
        return;
    }
    if (Date.now() - lastProgressAt > STUCK_TIMEOUT) {
        recoverFromStuck();
        return;
    }

    // 1. THIS CONTROLS SCROLL DISTANCE (currently 300-400 pixels)
    const scrollDistance = Math.floor(Math.random() * 100) + 300;

    // Smooth scroll
    window.scrollBy({
        top: scrollDistance,
        behavior: 'smooth'
    });

    // 2. THIS CONTROLS THE DELAY (currently 600-1500ms)
    const nextDelay = Math.floor(Math.random() * 900) + 200;

    autoScrollInterval = setTimeout(humanLikeScroll, nextDelay);
}

// Start auto-scrolling (stopDate: optional 'YYYY-MM-DD' or ISO deadline; known: optional known-post stop)
function startAutoScroll(stopDate, known) {
    if (isAutoScrolling) return;

    console.log('Starting auto-scroll...');
    isAutoScrolling = true;
    isRecovering = false;
    deadlineDate = stopDate || null;
    deadline = stopDate ? new Date(stopDate.includes('T') ? stopDate : stopDate + 'T00:00:00') : null;
    stuckInARow = 0;
    oldestSeen = null;
    oldPostKeys.clear();
    knownStop = known && known.runStart ? { runStart: known.runStart, gaps: known.gaps || [], minKnown: known.minKnown || 6 } : null;
    knownJudged.clear();
    knownQueue = [];
    knownStopReached = false;
    sawUnknown = false;
    knownRun = 0;
    resetProgress();

    // Send message to popup
    browserAPI.runtime.sendMessage({
        type: 'AUTO_SCROLL_STATUS',
        isScrolling: true
    }).catch(() => {});

    humanLikeScroll();
}

// Stop auto-scrolling (reason: 'manual', 'deadline', 'known' or 'end-of-feed')
function stopAutoScroll(reason = 'manual') {
    if (!isAutoScrolling) return;

    console.log('Stopping auto-scroll...');
    isAutoScrolling = false;

    if (autoScrollInterval) {
        clearTimeout(autoScrollInterval);
        autoScrollInterval = null;
    }

    // Send message to popup and background
    browserAPI.runtime.sendMessage({
        type: 'AUTO_SCROLL_STATUS',
        isScrolling: false,
        reason,
        deadline: reason === 'deadline' ? deadlineDate : null,
        oldest: oldestSeen
    }).catch(() => {});
}

// Listen for messages from background script and popup
browserAPI.runtime.onMessage.addListener((message) => {
    if (message.type === 'CLEAR_CACHE') {
        seenPairs.clear();
        console.log('Twitter Ticker Extractor: Cache cleared');
    } else if (message.type === 'START_AUTO_SCROLL') {
        if (location.pathname === '/home' && !isFollowingTabSelected()) {
            return Promise.resolve({ ok: false, error: 'Switch to the Following tab first' });
        }
        startAutoScroll(message.stopDate, message.knownStop);
        return Promise.resolve({ ok: true });
    } else if (message.type === 'STOP_AUTO_SCROLL') {
        stopAutoScroll();
    } else if (message.type === 'GET_AUTO_SCROLL_STATUS') {
        return Promise.resolve({ isScrolling: isAutoScrolling });
    }
});
