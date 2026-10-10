// Turso (libSQL) HTTP client, shared by the extension background script and the Playwright scraper.
// Uses the /v2/pipeline endpoint, so no SDK is needed.

function tursoPipelineUrl(config) {
    return config.url.replace(/^libsql:\/\//, 'https://') + '/v2/pipeline';
}

async function tursoExecute(config, stmts) {
    const res = await fetch(tursoPipelineUrl(config), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.authToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            requests: [...stmts.map(stmt => ({ type: 'execute', stmt })), { type: 'close' }]
        })
    });
    if (!res.ok) {
        throw new Error(`Turso HTTP ${res.status}`);
    }
    const data = await res.json();
    const failed = data.results.find(r => r.type === 'error');
    if (failed) {
        throw new Error(failed.error.message);
    }
    return data.results;
}

// ---------- Schema ----------

// 'https://x.com/Some_User/status/123' -> 'some_user'
function tursoAuthorFromUrl(url) {
    const m = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)\/status\//i.exec(url || '');
    return m ? m[1].toLowerCase() : null;
}

// Create / migrate the table and indexes. Safe to run on every start.
async function tursoEnsureSchema(config) {
    await tursoExecute(config, [{
        sql: `CREATE TABLE IF NOT EXISTS ticker_posts (
            ticker TEXT NOT NULL,
            url TEXT NOT NULL,
            timestamp TEXT,
            author TEXT,
            source TEXT,
            inserted_at TEXT,
            PRIMARY KEY (ticker, url)
        )`
    }, { sql: 'PRAGMA table_info(ticker_posts)' }]).then(async results => {
        const existing = new Set(results[1].response.result.rows.map(r => r[1].value));
        const missing = ['author', 'source', 'inserted_at'].filter(c => !existing.has(c));
        if (missing.length > 0) {
            await tursoExecute(config, missing.map(c => ({ sql: `ALTER TABLE ticker_posts ADD COLUMN ${c} TEXT` })));
        }
    });

    await tursoExecute(config, [
        // Backfill author for rows created before the column existed
        {
            sql: `UPDATE ticker_posts
                  SET author = lower(substr(url, 15, instr(substr(url, 15), '/') - 1))
                  WHERE author IS NULL AND url LIKE 'https://x.com/%/status/%'`
        },
        { sql: 'CREATE INDEX IF NOT EXISTS idx_ticker_posts_timestamp ON ticker_posts(timestamp)' },
        { sql: 'CREATE INDEX IF NOT EXISTS idx_ticker_posts_ticker ON ticker_posts(ticker)' },
        { sql: 'CREATE INDEX IF NOT EXISTS idx_ticker_posts_author ON ticker_posts(author)' }
    ]);
}

// Kept for older callers
const tursoEnsureTable = tursoEnsureSchema;

// ---------- Writes ----------

function tursoInsertStmt(pair, source) {
    const text = value => (value ? { type: 'text', value } : { type: 'null' });
    return {
        sql: `INSERT OR IGNORE INTO ticker_posts (ticker, url, timestamp, author, source, inserted_at)
              VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        args: [
            text(pair.ticker),
            text(pair.url),
            text(pair.timestamp),
            text(tursoAuthorFromUrl(pair.url)),
            text(source)
        ]
    };
}

// Upload pairs in chunks; duplicates are ignored server-side (PRIMARY KEY ticker+url).
// `source` records where a row came from ('extension', 'scraper', ...).
async function tursoUploadPairs(config, pairs, source = null) {
    const CHUNK = 200;
    for (let i = 0; i < pairs.length; i += CHUNK) {
        await tursoExecute(config, pairs.slice(i, i + CHUNK).map(p => tursoInsertStmt(p, source)));
    }
}

// ---------- Reads ----------

const tursoVal = cell => (cell.type === 'null' ? null : cell.value);

// Number of rows in ticker_posts, plus how many distinct tickers
async function tursoCounts(config) {
    const results = await tursoExecute(config, [
        { sql: 'SELECT COUNT(*) FROM ticker_posts' },
        { sql: 'SELECT COUNT(DISTINCT ticker) FROM ticker_posts' }
    ]);
    const val = r => Number(r.response.result.rows[0][0].value);
    return { pairs: val(results[0]), tickers: val(results[1]) };
}

// WHERE clause + args shared by the ranking queries.
// Pairs without a timestamp are always counted, like the old local analysis.
function tursoRangeFilter(cutoffIso) {
    if (!cutoffIso) return { where: '', args: [] };
    return { where: 'WHERE (timestamp >= ? OR timestamp IS NULL)', args: [{ type: 'text', value: cutoffIso }] };
}

// Most mentioned tickers. unique = true (default) counts each author at most once per ticker per day
// (UTC day); the raw number of posts is returned as well. Also returns distinct authors and latest post.
async function tursoTopMentions(config, cutoffIso, limit = 10, unique = true) {
    const { where, args } = tursoRangeFilter(cutoffIso);
    args.push({ type: 'integer', value: String(limit) });
    const results = await tursoExecute(config, [{
        sql: `SELECT ticker, COUNT(*) AS raw,
                     COUNT(DISTINCT COALESCE(author, '?') || '|' || COALESCE(substr(timestamp, 1, 10), '')) AS uniq,
                     COUNT(DISTINCT author) AS authors, MAX(timestamp) AS latest
              FROM ticker_posts ${where}
              GROUP BY ticker ORDER BY ${unique ? 'uniq' : 'raw'} DESC, raw DESC, ticker LIMIT ?`,
        args
    }]);
    return results[0].response.result.rows.map(([ticker, raw, uniq, authors, latest]) => ({
        ticker: tursoVal(ticker),
        count: Number(tursoVal(unique ? uniq : raw)),
        raw: Number(tursoVal(raw)),
        unique: Number(tursoVal(uniq)),
        authors: Number(tursoVal(authors)),
        latest: tursoVal(latest)
    }));
}

// Posts per day between two ISO dates (inclusive), for coverage checks
async function tursoDailyCounts(config, fromDate, toDate) {
    const results = await tursoExecute(config, [{
        sql: `SELECT substr(timestamp, 1, 10) AS day, COUNT(DISTINCT url) AS posts, COUNT(DISTINCT author) AS authors
              FROM ticker_posts
              WHERE substr(timestamp, 1, 10) BETWEEN ? AND ?
              GROUP BY day ORDER BY day`,
        args: [{ type: 'text', value: fromDate }, { type: 'text', value: toDate }]
    }]);
    return results[0].response.result.rows.map(([day, posts, authors]) => ({
        day: tursoVal(day),
        posts: Number(tursoVal(posts)),
        authors: Number(tursoVal(authors))
    }));
}

// Server clock, so "before this run started" is judged on Turso's own time
async function tursoServerNow(config) {
    const results = await tursoExecute(config, [{ sql: "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" }]);
    return tursoVal(results[0].response.result.rows[0][0]);
}

// Which of these post URLs does the database already have? Rows inserted at or after beforeIso do not
// count (they were collected by the current run), rows without inserted_at (imports) do.
async function tursoKnownUrls(config, urls, beforeIso) {
    const known = [];
    const CHUNK = 100;
    for (let i = 0; i < urls.length; i += CHUNK) {
        const chunk = urls.slice(i, i + CHUNK);
        const results = await tursoExecute(config, [{
            sql: `SELECT DISTINCT url FROM ticker_posts
                  WHERE url IN (${chunk.map(() => '?').join(',')}) AND (inserted_at IS NULL OR inserted_at < ?)`,
            args: [...chunk.map(value => ({ type: 'text', value })), { type: 'text', value: beforeIso }]
        }]);
        results[0].response.result.rows.forEach(r => known.push(tursoVal(r[0])));
    }
    return known;
}

// ---------- Coverage ----------
// A day only counts as collected when it has at least this many posts. Fewer than that means the
// day was only touched (e.g. a few posts picked up just by loading the page), so it is "missing".
const TURSO_COVERED_MIN_POSTS = 30;
// Gaps older than this are reported as missing but are not what "Catch up" goes after
// (X only serves a limited depth of the feed, so very old holes cannot be filled by catching up).
const TURSO_CATCH_UP_MAX_AGE_DAYS = 14;

// Pure function: days = [{day: 'YYYY-MM-DD', posts, first, last}] (UTC days), any order.
// floorDay ('YYYY-MM-DD', optional): the oldest day the feed was last seen to reach. Gaps entirely
// older than it are flagged unreachable and are not offered for filling.
function tursoCoverageFromDays(days, now = new Date(), minPosts = TURSO_COVERED_MIN_POSTS, floorDay = null) {
    const byDay = new Map(days.map(d => [d.day, d]));
    const covered = days.filter(d => d.posts >= minPosts).sort((a, b) => (a.day < b.day ? -1 : 1));
    const newestAny = days.reduce((m, d) => (d.last && (!m || d.last > m) ? d.last : m), null);
    if (covered.length === 0) {
        return { newest: newestAny, from: null, fromDay: null, to: null, toDay: null, coveredDays: 0,
                 missing: [], gaps: [], fillFrom: null, catchUpFrom: null, minPosts };
    }

    const firstCovered = covered[0];
    const lastCovered = covered[covered.length - 1];
    const todayStr = now.toISOString().slice(0, 10);
    const endDay = todayStr > lastCovered.day ? todayStr : lastCovered.day;

    // Every calendar day from the first covered day until today
    const list = [];
    for (let d = new Date(firstCovered.day + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= endDay; d = new Date(d.getTime() + 864e5)) {
        const day = d.toISOString().slice(0, 10);
        const row = byDay.get(day);
        list.push({ day, posts: row ? row.posts : 0, covered: !!row && row.posts >= minPosts, isToday: day === todayStr });
    }
    const missing = list.filter(d => !d.covered).map(({ day, posts, isToday }) => ({ day, posts, isToday }));

    // Gaps = runs of consecutive missing days. anchor = last post of the covered day just below the gap
    // (list[0] is covered, so such a day always exists).
    const gaps = [];
    let run = null;
    for (const d of list) {
        if (d.covered) { run = null; continue; }
        if (!run) {
            const below = new Date(Date.parse(d.day) - 864e5).toISOString().slice(0, 10);
            run = { fromDay: d.day, toDay: d.day, days: 0, posts: 0, includesToday: false, anchor: byDay.get(below).last };
            gaps.push(run);
        }
        run.toDay = d.day;
        run.days++;
        run.posts += d.posts;
        if (d.isToday) run.includesToday = true;
    }
    gaps.forEach(g => { g.unreachable = !!floorDay && g.toDay < floorDay; });
    // One pass from the top fills every gap above its stopping point, so aim at the OLDEST fillable gap
    const oldestFillable = gaps.find(g => !g.unreachable);
    const fillFrom = oldestFillable ? oldestFillable.anchor : null;

    // Catch-up anchor: walk down from today past any covered days at the top, to the most recent
    // gap; the anchor is the last post of the covered day just below that gap.
    let catchUpFrom = lastCovered.last;
    let i = list.length - 1;
    while (i >= 0 && list[i].covered) i--;
    if (i >= 0) {
        const gapTopAge = (Date.parse(todayStr) - Date.parse(list[i].day)) / 864e5;
        if (gapTopAge <= TURSO_CATCH_UP_MAX_AGE_DAYS) {
            let j = i;
            while (j >= 0 && !list[j].covered) j--;
            catchUpFrom = byDay.get(list[j].day).last; // list[0] is covered, so j >= 0
        }
    }

    return {
        newest: newestAny,
        from: firstCovered.first,
        fromDay: firstCovered.day,
        to: lastCovered.last,
        toDay: lastCovered.day,
        coveredDays: covered.length,
        missing,
        gaps,
        fillFrom,
        catchUpFrom,
        minPosts
    };
}

async function tursoCoverage(config, floorDay = null) {
    const results = await tursoExecute(config, [{
        sql: `SELECT substr(timestamp, 1, 10) AS day, COUNT(DISTINCT url) AS posts,
                     MIN(timestamp) AS first, MAX(timestamp) AS last
              FROM ticker_posts WHERE timestamp IS NOT NULL
              GROUP BY day`
    }]);
    const days = results[0].response.result.rows.map(([day, posts, first, last]) => ({
        day: tursoVal(day), posts: Number(tursoVal(posts)), first: tursoVal(first), last: tursoVal(last)
    }));
    return tursoCoverageFromDays(days, new Date(), TURSO_COVERED_MIN_POSTS, floorDay);
}

if (typeof module !== 'undefined') {
    module.exports = {
        tursoExecute, tursoAuthorFromUrl, tursoEnsureSchema, tursoEnsureTable,
        tursoUploadPairs, tursoCounts, tursoTopMentions, tursoDailyCounts, tursoCoverage, tursoCoverageFromDays, tursoServerNow, tursoKnownUrls
    };
}
