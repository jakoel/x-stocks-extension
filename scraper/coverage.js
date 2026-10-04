// Coverage check: posts per day in Turso, with gaps flagged.
//   node coverage.js [--from 2026-09-01] [--to 2026-09-30]
//
// A day is flagged when it has no posts, or far fewer than a typical day (under 40% of the median).
// Weekends are naturally quieter, so check flagged weekend days before re-scraping.

const fs = require('fs');
const path = require('path');
const { tursoDailyCounts, tursoExecute } = require('../turso.js');

const argValue = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : fallback;
};

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'turso.json'), 'utf8'));
const config = { url: cfg.url, authToken: cfg.auth_token };

const from = argValue('--from', '2026-09-01');
const to = argValue('--to', '2026-09-30');

function eachDay(fromDate, toDate) {
    const days = [];
    for (let d = new Date(fromDate + 'T00:00:00Z'); d <= new Date(toDate + 'T00:00:00Z'); d = new Date(d.getTime() + 864e5)) {
        days.push(d.toISOString().slice(0, 10));
    }
    return days;
}

(async () => {
    const rows = await tursoDailyCounts(config, from, to);
    const byDay = new Map(rows.map(r => [r.day, r]));
    const days = eachDay(from, to);

    const counts = days.map(d => (byDay.get(d) || { posts: 0 }).posts).filter(n => n > 0).sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    const threshold = median * 0.4;

    const oldest = (await tursoExecute(config, [{ sql: 'SELECT MIN(timestamp) FROM ticker_posts' }]))[0].response.result.rows[0][0].value;

    console.log(`Coverage ${from} .. ${to}   (median ${median} posts/day, flag below ${Math.round(threshold)})\n`);
    console.log('day         wk   posts  authors');
    let flagged = 0;
    for (const day of days) {
        const r = byDay.get(day) || { posts: 0, authors: 0 };
        const wk = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][new Date(day + 'T00:00:00Z').getUTCDay()];
        const bad = r.posts === 0 || r.posts < threshold;
        if (bad) flagged++;
        const bar = '#'.repeat(Math.min(40, Math.round((r.posts / Math.max(median, 1)) * 20)));
        console.log(`${day}  ${wk}  ${String(r.posts).padStart(6)}  ${String(r.authors).padStart(7)}  ${bar}${bad ? '  <-- check' : ''}`);
    }

    console.log(`\n${days.length - flagged}/${days.length} days look covered, ${flagged} flagged.`);
    if (oldest && oldest > from + 'T00:00:00.000Z') {
        console.log(`Note: the oldest post in the database is ${oldest}, which is after ${from}.`);
    }
})().catch(err => {
    console.error('ERR', err.message);
    process.exit(1);
});
