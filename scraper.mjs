#!/usr/bin/env node
// Scraper putusan PK (peninjauan kembali) perkara pajak — putusan3.mahkamahagung.go.id
//
// Usage (run from the project root; output goes to ./data):
//   npm run scrape                 # crawl listings + details, PK only → data/putusan.jsonl + .csv
//   node scraper.mjs --all         # keep non-PK decisions too
//   node scraper.mjs --pdf         # also download the PDF of every kept decision
//   node scraper.mjs --limit 20    # stop after 20 detail pages (for testing)
//   node scraper.mjs --max-listing-pages 50
//   node scraper.mjs --workers 3   # parallel detail pages (default 2)
//   node scraper.mjs --recrawl     # ignore the data/listings.json cache
//   node scraper.mjs --delay 1500  # ms between requests per worker
//
// Output (resumable: already-scraped URLs in data/putusan.jsonl are skipped):
//   data/putusan.jsonl   full records (one JSON per line)
//   data/putusan.csv     flat CSV export
//   data/scraper.log     log of the current run (used by progress-bar.mjs)
//   data/pdf/*.pdf       only with --pdf
//
// Requires Google Chrome (used via channel: 'chrome') — see README.
import { chromium } from 'playwright-core';
import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// outputs live in ./data relative to where the command runs (or $PUTUSAN_DATA)
const OUT_DIR = process.env.PUTUSAN_DATA ?? join(process.cwd(), 'data');
const JSONL = join(OUT_DIR, 'putusan.jsonl');
const CSV = join(OUT_DIR, 'putusan.csv');
const LISTINGS = join(OUT_DIR, 'listings.json');
const PDF_DIR = join(OUT_DIR, 'pdf');
const LOG_FILE = join(OUT_DIR, 'scraper.log');
const PROFILE_DIR = join(OUT_DIR, '.chrome-profile');

const SEEDS = [
  'https://putusan3.mahkamahagung.go.id/direktori/index/pengadilan/mahkamah-agung/kategori/pajak.html',
  'https://putusan3.mahkamahagung.go.id/direktori/index/pengadilan/mahkamah-agung/kategori/pajak-2.html',
];

// ---- CLI args -------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, dflt) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const OPT_ALL = flag('--all');
const OPT_PDF = flag('--pdf');
const LIMIT = opt('--limit', Infinity);
const MAX_LISTING = opt('--max-listing-pages', Infinity);
const DELAY = opt('--delay', 800);

mkdirSync(OUT_DIR, { recursive: true });
if (OPT_PDF) mkdirSync(PDF_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// log in local time — to the console AND to data/scraper.log (fresh per run)
const logStream = createWriteStream(LOG_FILE, { flags: 'w' });
const log = (...m) => {
  const line = `${new Date().toLocaleTimeString('en-GB', { hour12: false })} ${m.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
};

// ---- resume: URLs already scraped ----------------------------------------
const done = new Set();
if (existsSync(JSONL)) {
  for (const line of readFileSync(JSONL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.url) done.add(rec.url);
    } catch { /* skip broken line */ }
  }
}
log(`resume: ${done.size} detail pages already in ${JSONL}`);

// ---- browser --------------------------------------------------------------
// persistent profile: keeps the cf_clearance cookie across runs
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  locale: 'id-ID',
});

// Navigate and wait out the Cloudflare challenge (any locale: "Just a moment..." / "Tunggu sebentar...")
async function load(page, url, tries = 2) {
  for (let t = 1; t <= tries; t++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      log('  goto error', url, e.message.split('\n')[0]);
      continue;
    }
    try {
      await page.waitForFunction(
        () => {
          const t = document.title.toLowerCase();
          return (
            t.length > 0 &&
            !t.includes('just a moment') &&
            !t.includes('tunggu sebentar') &&
            !t.includes('attention required')
          );
        },
        { timeout: 45000 },
      );
      return true;
    } catch {
      log(`  ⚠ challenge not cleared (try ${t}/${tries}):`, url, '| title:', await page.title());
    }
  }
  return false;
}

// ---- phase 1: crawl listing pages ---------------------------------------
// Deterministic enumeration: every tax category slug is walked through both URL
// families the site uses (old-style `slug-N.html` and new-style `slug/page/N.html`)
// until the data runs out, so one failed page cannot break the whole crawl.
async function crawlListings() {
  const BASE =
    'https://putusan3.mahkamahagung.go.id/direktori/index/pengadilan/mahkamah-agung/kategori/';
  const entries = new Map(); // detailUrl -> listing metadata
  // `pajak-2` etc. are category slugs in their own right (they carry their own
  // /page/N pagination), so raw slugs are kept AND their `-\d+`-stripped bases
  // are walked through the old-style `base-N.html` family as a safety net.
  const rawSlugs = new Set(['pajak', 'pajak-2']);
  const bases = new Set(['pajak']);
  const tasks = []; // {slug, family: 'old' | 'new'}
  const queued = new Set();
  const failed = [];
  let inflight = 0;
  let fetched = 0;

  function addTask(slug, family) {
    const key = `${slug}|${family}`;
    if (queued.has(key)) return;
    queued.add(key);
    tasks.push({ slug, family });
  }
  addTask('pajak', 'new');
  addTask('pajak-2', 'new');
  addTask('pajak', 'old');

  // fetch one listing page; returns {fresh, total} or null on failure
  async function grab(page, url) {
    if (fetched >= MAX_LISTING) return null;
    fetched++;
    if (!(await load(page, url))) {
      failed.push(url);
      return null;
    }
    const res = await page.evaluate(() => {
      const found = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('div.spost a[href*="/direktori/putusan/"]')) {
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        const box = a.closest('div.spost') ?? a.parentElement;
        const text = (box?.innerText ?? a.textContent).replace(/\s+/g, ' ').trim();
        found.push({ href: a.href, text: text.slice(0, 600) });
      }
      const slugs = [...document.querySelectorAll('a[href]')]
        .map((a) => a.href.split('#')[0])
        .filter((h) => /mahkamah-agung\/kategori\/pajak[^/]*\.html$/.test(h))
        .map((h) => h.split('/kategori/')[1].replace(/\.html$/, ''));
      // highest page number mentioned in pagination links
      let maxPage = 0;
      for (const a of document.querySelectorAll('a[href*="/page/"]')) {
        const m = a.href.match(/\/page\/(\d+)\.html/);
        if (m) maxPage = Math.max(maxPage, Number(m[1]));
      }
      return { found, slugs: [...new Set(slugs)], maxPage };
    });
    let fresh = 0;
    for (const f of res.found) {
      if (!entries.has(f.href)) {
        entries.set(f.href, f.text);
        fresh++;
      }
    }
    for (const s of res.slugs) {
      if (!s) continue;
      if (!rawSlugs.has(s)) {
        rawSlugs.add(s);
        addTask(s, 'new');
      }
      const base = s.replace(/-\d+$/, '');
      if (base && !bases.has(base)) {
        bases.add(base);
        addTask(base, 'old');
      }
    }
    log(`  ${res.found.length} entries (${fresh} new) ← ${url.replace(BASE, '')}`);
    return { fresh, total: res.found.length, maxPage: res.maxPage };
  }

  // walk one URL family until the data runs out
  async function crawlFamily(page, { slug, family }) {
    let stale = 0;
    let fails = 0;
    let holes = 0;
    let target = 1200; // hard cap unless pagination shows the real last page
    const staleStop = family === 'new' ? 15 : 5;
    for (let n = 1; n <= target; n++) {
      const url =
        family === 'old'
          ? `${BASE}${slug}-${n}.html`
          : n === 1
            ? `${BASE}${slug}.html`
            : `${BASE}${slug}/page/${n}.html`;
      const r = await grab(page, url);
      if (r === null) {
        if (++fails >= 3) break;
        continue;
      }
      fails = 0;
      if (r.total === 0) {
        if (++holes >= 2) break; // real end of family (one gap is tolerated)
        continue;
      }
      holes = 0;
      if (family === 'new' && r.maxPage > n) {
        target = Math.min(1200, r.maxPage); // walk to the real last page
      }
      if (r.fresh === 0) {
        if (++stale >= staleStop) break; // alias family or clamped page
      } else {
        stale = 0;
      }
      await sleep(DELAY);
    }
    log(`family done: ${slug} (${family}) — ${entries.size} unique so far`);
  }

  async function pump() {
    const page = await ctx.newPage();
    while (true) {
      const task = tasks.shift();
      if (!task) {
        if (inflight === 0) break; // queue drained, nothing in flight → done
        await sleep(150);
        continue;
      }
      inflight++;
      try {
        await crawlFamily(page, task);
      } catch (e) {
        log('  family error', task.slug, task.family, e.message.split('\n')[0]);
      }
      inflight--;
    }
    await page.close();
  }

  await Promise.all([pump(), pump(), pump()]);

  // one retry pass for pages that failed during the crawl
  if (failed.length) {
    log(`retrying ${failed.length} failed listing pages…`);
    const page = await ctx.newPage();
    for (const url of [...new Set(failed)]) {
      await grab(page, url);
      await sleep(DELAY);
    }
    await page.close();
  }

  log(`listing crawl done: ${fetched} pages fetched, ${entries.size} unique decisions`);
  return entries;
}

// ---- phase 2: scrape detail pages ---------------------------------------
function parseDetail() {
  const txt = (s) => document.querySelector(s)?.textContent.trim() ?? '';
  const fields = {};
  for (const row of document.querySelectorAll('table tr')) {
    const cells = row.querySelectorAll('td');
    if (cells.length === 2) {
      const k = cells[0].textContent.trim();
      const v = cells[1].textContent.trim().replace(/\s+/g, ' ').slice(0, 2000);
      if (k) fields[k] = v;
    }
  }
  const links = [...document.querySelectorAll('a[href*="download_file"]')].map((a) => a.href);
  const h2 = txt('h2');
  const tanggalPutusan = (h2.match(/Tanggal\s+([0-9]{1,2}\s+\S+\s+[0-9]{4})/) ?? [])[1] ?? null;
  return {
    h2,
    tanggal_putusan: tanggalPutusan,
    para_pihak: txt('#title_pihak') || null,
    fields,
    pdf_url: links.find((l) => /\/pdf\//.test(l)) ?? null,
    zip_url: links.find((l) => /\/zip\//.test(l)) ?? null,
  };
}

function buildRecord(url, listingText, d) {
  const f = d.fields;
  const nomor = f['Nomor'] ?? (d.h2.match(/Nomor\s+(\S+)/) ?? [])[1] ?? null;
  const tingkat = f['Tingkat Proses'] ?? null;
  const is_pk = /\/PK\//i.test(nomor ?? '') || /Peninjauan Kembali/i.test(tingkat ?? '');
  const listingMeta = {};
  const mViews = (listingText ?? '').match(/Jumlah view">(\d+)/);
  const mDown = (listingText ?? '').match(/Jumlah download">(\d+)/);
  if (mViews) listingMeta.views = Number(mViews[1]);
  if (mDown) listingMeta.downloads = Number(mDown[1]);
  return {
    url,
    nomor,
    tingkat_proses: tingkat,
    is_pk,
    klasifikasi: f['Klasifikasi'] ?? null,
    kata_kunci: f['Kata Kunci'] ?? null,
    tahun: f['Tahun'] ?? null,
    lembaga_peradilan: f['Lembaga Peradilan'] ?? null,
    jenis_lembaga: f['Jenis Lembaga Peradilan'] ?? null,
    hakim_ketua: f['Hakim Ketua'] ?? null,
    hakim_anggota: f['Hakim Anggota'] ?? null,
    panitera: f['Panitera'] ?? null,
    amar: f['Amar'] ?? null,
    amar_lainnya: f['Amar Lainnya'] ?? null,
    catatan_amar: f['Catatan Amar'] ?? null,
    kaidah: f['Kaidah'] ?? null,
    status: f['Status'] ?? null,
    abstrak: f['Abstrak'] ?? null,
    tanggal_musyawarah: f['Tanggal Musyawarah'] ?? null,
    tanggal_dibacakan: f['Tanggal Dibacakan'] ?? null,
    tanggal_register: f['Tanggal Register'] ?? null,
    tanggal_putusan: d.tanggal_putusan,
    para_pihak: d.para_pihak,
    pdf_url: d.pdf_url,
    zip_url: d.zip_url,
    ...listingMeta,
    scraped_at: new Date().toISOString(),
  };
}

const sanitize = (s) => (s ?? 'tanpa-nomor').replace(/[^\w.-]+/g, '-');

async function downloadPdf(rec) {
  if (!rec.pdf_url) return;
  const file = join(PDF_DIR, `${sanitize(rec.nomor)}.pdf`);
  if (existsSync(file)) return;
  try {
    const resp = await ctx.request.get(rec.pdf_url, { timeout: 120000 });
    if (resp.ok()) writeFileSync(file, Buffer.from(await resp.body()));
    else log('  pdf HTTP', resp.status(), rec.nomor);
  } catch (e) {
    log('  pdf error', rec.nomor, e.message.split('\n')[0]);
  }
}

// ---- phase 3: CSV export --------------------------------------------------
const CSV_COLS = [
  'nomor', 'tingkat_proses', 'is_pk', 'tahun', 'tanggal_putusan', 'para_pihak',
  'klasifikasi', 'kata_kunci', 'status', 'amar', 'amar_lainnya', 'catatan_amar',
  'kaidah', 'abstrak', 'hakim_ketua', 'hakim_anggota', 'panitera',
  'lembaga_peradilan', 'jenis_lembaga', 'tanggal_musyawarah', 'tanggal_dibacakan',
  'tanggal_register', 'views', 'downloads', 'pdf_url', 'zip_url', 'url', 'scraped_at',
];

function exportCsv() {
  const rows = readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    return `"${String(v).replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
  };
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) lines.push(CSV_COLS.map((c) => esc(r[c])).join(','));
  writeFileSync(CSV, lines.join('\n') + '\n');
  log(`csv export: ${rows.length} rows → ${CSV}`);
  return rows;
}

// ---- main -----------------------------------------------------------------
// listing index is cached: a restarted run skips the (slow) listing crawl
let entries;
if (existsSync(LISTINGS) && !flag('--recrawl')) {
  entries = new Map(JSON.parse(readFileSync(LISTINGS, 'utf8')));
  log(`listings cache: ${entries.size} decisions from ${LISTINGS}`);
} else {
  entries = await crawlListings();
  writeFileSync(LISTINGS, JSON.stringify([...entries]));
  log(`listings saved → ${LISTINGS}`);
}

// pre-filter on the listing title ("Nomor 2034/B/PK/Pjk/2026") to skip non-PK details
const targets = [...entries.entries()].filter(([url, text]) =>
  OPT_ALL || /\/PK\//i.test(text) || /Peninjauan Kembali/i.test(text),
);
log(`targets: ${targets.length} / ${entries.size} decisions${OPT_ALL ? ' (--all)' : ' (PK only)'}`);

const queue = targets.filter(([url]) => !done.has(url));
log(`to scrape now: ${queue.length} (skipping ${targets.length - queue.length} already done)`);

const workers = opt('--workers', 2);
let idx = 0;
let kept = 0;

async function worker(wid) {
  const page = await ctx.newPage();
  while (true) {
    const i = idx++;
    if (i >= queue.length || i >= LIMIT) break;
    const [url, listingText] = queue[i];
    log(`[w${wid}] detail ${i + 1}/${Math.min(queue.length, LIMIT)}: ${url}`);
    if (!(await load(page, url))) continue;

    const d = await page.evaluate(parseDetail);
    const rec = buildRecord(url, listingText, d);
    if (!OPT_ALL && !rec.is_pk) {
      log(`  skip non-PK: ${rec.nomor}`);
    } else {
      appendFileSync(JSONL, JSON.stringify(rec) + '\n');
      kept++;
      log(`  ✓ ${rec.nomor} | ${rec.tingkat_proses} | ${rec.para_pihak?.slice(0, 60) ?? ''}`);
      if (OPT_PDF) await downloadPdf(rec);
    }
    await sleep(DELAY);
  }
  await page.close();
}

await Promise.all(Array.from({ length: workers }, (_, w) => worker(w + 1)));

const rows = exportCsv();
const pk = rows.filter((r) => r.is_pk).length;
log(`DONE — ${kept} new records this run, ${rows.length} total (${pk} PK)`);
await ctx.close();
