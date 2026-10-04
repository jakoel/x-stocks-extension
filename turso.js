// Turso (libSQL) HTTP client, shared by the extension background script and the Playwright scraper.
// Uses the /v2/pipeline endpoint, so no SDK is needed.

// Obvious crypto cashtags, excluded from rankings unless "include crypto" is on.
// Deliberately left out: symbols that are also stock tickers (e.g. SOL, LINK, DOT).
const TURSO_CRYPTO_TICKERS = ['BTC', 'ETH', 'XRP', 'DOGE', 'ZEC', 'BNB', 'ADA', 'SHIB', 'LTC', 'USDT', 'USDC', 'PEPE', 'TRX', 'SUI'];

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
function tursoRangeFilter(cutoffIso, includeCrypto) {
    const conditions = [];
    const args = [];
    if (cutoffIso) {
        conditions.push('(timestamp >= ? OR timestamp IS NULL)');
        args.push({ type: 'text', value: cutoffIso });
    }
    if (!includeCrypto) {
        conditions.push(`ticker NOT IN (${TURSO_CRYPTO_TICKERS.map(t => `'${t}'`).join(', ')})`);
    }
    return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', args };
}

// Most mentioned tickers: mentions, distinct authors, latest post time
async function tursoTopMentions(config, cutoffIso, limit = 10, includeCrypto = false) {
    const { where, args } = tursoRangeFilter(cutoffIso, includeCrypto);
    args.push({ type: 'integer', value: String(limit) });
    const results = await tursoExecute(config, [{
        sql: `SELECT ticker, COUNT(*) AS n, COUNT(DISTINCT author) AS authors, MAX(timestamp) AS latest
              FROM ticker_posts ${where}
              GROUP BY ticker ORDER BY n DESC, ticker LIMIT ?`,
        args
    }]);
    return results[0].response.result.rows.map(([ticker, n, authors, latest]) => ({
        ticker: tursoVal(ticker),
        count: Number(tursoVal(n)),
        authors: Number(tursoVal(authors)),
        latest: tursoVal(latest)
    }));
}

// Most active authors: distinct posts, distinct tickers, latest post time
async function tursoTopAuthors(config, cutoffIso, limit = 10, includeCrypto = false) {
    const { where, args } = tursoRangeFilter(cutoffIso, includeCrypto);
    args.push({ type: 'integer', value: String(limit) });
    const results = await tursoExecute(config, [{
        sql: `SELECT author, COUNT(DISTINCT url) AS posts, COUNT(DISTINCT ticker) AS tickers, MAX(timestamp) AS latest
              FROM ticker_posts ${where ? where + ' AND author IS NOT NULL' : 'WHERE author IS NOT NULL'}
              GROUP BY author ORDER BY posts DESC, author LIMIT ?`,
        args
    }]);
    return results[0].response.result.rows.map(([author, posts, tickers, latest]) => ({
        author: tursoVal(author),
        count: Number(tursoVal(posts)),
        tickers: Number(tursoVal(tickers)),
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

if (typeof module !== 'undefined') {
    module.exports = {
        TURSO_CRYPTO_TICKERS, tursoExecute, tursoAuthorFromUrl, tursoEnsureSchema, tursoEnsureTable,
        tursoUploadPairs, tursoCounts, tursoTopMentions, tursoTopAuthors, tursoDailyCounts
    };
}
