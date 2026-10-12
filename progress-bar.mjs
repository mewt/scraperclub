#!/usr/bin/env node
// Live progress bar for the scraper (uses the `cli-progress` npm package).
// Works while scraper.mjs is running — just reads its log and data files.
// Usage: node progress-bar.mjs [path/to/scraper.log]
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import cliProgress from 'cli-progress';

const OUT_DIR = process.env.PUTUSAN_DATA ?? join(process.cwd(), 'data');
const LOG = process.argv[2] ?? join(OUT_DIR, 'scraper.log');
const JSONL = join(OUT_DIR, 'putusan.jsonl');
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function snapshot() {
  const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  const togoM = log.match(/to scrape now: (\d+) \(skipping (\d+) already done\)/);
  let found = 0;
  for (const m of log.matchAll(/\((\d+) new\)/g)) found += Number(m[1]);
  const records = existsSync(JSONL)
    ? readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).length
    : 0;
  const age = existsSync(LOG) ? Math.round((Date.now() - statSync(LOG).mtimeMs) / 1000) : 0;
  let running = false;
  try {
    running = execSync("pgrep -f 'node scraper.mjs' || true").toString().trim().length > 0;
  } catch {}
  return {
    done: log.includes('DONE —') || log.includes('DONE -'),
    running,
    togo: togoM ? Number(togoM[1]) : null,
    skipped: togoM ? Number(togoM[2]) : 0,
    pages: (log.match(/\(\d+ new\)/g) ?? []).length,
    found,
    records,
    age,
  };
}

const elapsed = () => {
  const s = Math.round(process.uptime());
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

// phase 1: text bar (no real total yet) — phase 2: real percentage bar
const phase1 = new cliProgress.SingleBar(
  {
    format: 'Listing crawl {spin} | pages fetched: {pages} | decisions found: {found} | idle: {age}s | {elapsed}',
    hideCursor: true,
    clearOnComplete: false,
    noTTYOutput: true,
    notTTYSchedule: 200,
  },
  cliProgress.Presets.shades_classic,
);
const phase2 = new cliProgress.SingleBar(
  {
    format:
      'Details {bar} {percentage}% | {value}/{total} decisions | listing pages: {pages} | idle: {age}s | ETA {eta_formatted}',
    hideCursor: true,
    clearOnComplete: false,
    noTTYOutput: true,
    notTTYSchedule: 200,
  },
  cliProgress.Presets.shades_classic,
);

let started2 = false;
let tick = 0;
phase1.start(1, 0, { spin: SPIN[0], pages: 0, found: 0, age: 0, elapsed: '0m00s' });

const timer = setInterval(() => {
  const s = snapshot();
  tick++;

  if (s.done) {
    if (started2) phase2.update(s.records);
    if (!started2) phase1.update(1, { spin: '✔', pages: s.pages, found: s.found, age: s.age, elapsed: elapsed() });
    (started2 ? phase2 : phase1).stop();
    clearInterval(timer);
    console.log(`\n✅ DONE — ${s.records} decisions in ${JSONL}`);
    console.log('Download PDFs next: node pdf_downloader.mjs');
    process.exit(0);
  }

  if (s.togo !== null && !started2) {
    // detail phase began → switch to the real progress bar
    phase1.stop();
    phase2.start(s.togo + s.skipped, s.records, { pages: s.pages, age: s.age });
    started2 = true;
    return;
  }

  if (started2) {
    phase2.update(Math.min(s.records, s.togo + s.skipped), { pages: s.pages, age: s.age });
  } else {
    phase1.update(0, {
      spin: SPIN[tick % SPIN.length],
      pages: s.pages,
      found: s.found,
      age: s.age,
      elapsed: elapsed(),
    });
  }

  if (!s.running && !s.done) {
    (started2 ? phase2 : phase1).stop();
    clearInterval(timer);
    console.log('\n🔴 Scraper is not running. Resume with: node scraper.mjs --delay 600');
    process.exit(1);
  }
}, 1000);