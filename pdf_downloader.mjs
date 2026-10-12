#!/usr/bin/env node
// PDF pass: downloads the PDF for every record in data/putusan.jsonl
// (run AFTER scraper.mjs; resumable — existing files are skipped)
// Usage: node pdf_downloader.mjs [--limit N] [--delay MS]
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = process.env.PUTUSAN_DATA ?? join(process.cwd(), 'data');
const JSONL = join(OUT_DIR, 'putusan.jsonl');
const PDF_DIR = join(OUT_DIR, 'pdf');
const PROFILE_DIR = join(OUT_DIR, '.chrome-profile');

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};
const LIMIT = opt('--limit', Infinity);
const DELAY = opt('--delay', 400);

mkdirSync(PDF_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toLocaleTimeString('en-GB', { hour12: false }), ...m);
const sanitize = (s) => (s ?? 'tanpa-nomor').replace(/[^\w.-]+/g, '-');

const records = readFileSync(JSONL, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.pdf_url);
log(`${records.length} records with pdf_url`);

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  locale: 'id-ID',
});
// warm up cookies against the site (Cloudflare)
const page = await ctx.newPage();
await page.goto('https://putusan3.mahkamahagung.go.id/beranda.html', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page
  .waitForFunction(() => {
    const t = document.title.toLowerCase();
    return (
      t.length > 0 &&
      !t.includes('just a moment') &&
      !t.includes('tunggu sebentar') &&
      !t.includes('attention required')
    );
  }, { timeout: 60000 })
  .catch(() => log('⚠ challenge not cleared, downloads may fail'));
await page.close();

let done = 0;
let failed = 0;
for (const rec of records.slice(0, LIMIT)) {
  const file = join(PDF_DIR, `${sanitize(rec.nomor)}.pdf`);
  if (existsSync(file)) continue;
  try {
    const resp = await ctx.request.get(rec.pdf_url, { timeout: 120000 });
    if (resp.ok()) {
      writeFileSync(file, Buffer.from(await resp.body()));
      done++;
      if (done % 25 === 0) log(`downloaded ${done} PDFs…`);
    } else {
      failed++;
      log('HTTP', resp.status(), rec.nomor);
    }
  } catch (e) {
    failed++;
    log('error', rec.nomor, e.message.split('\n')[0]);
  }
  await sleep(DELAY);
}

log(`DONE — ${done} downloaded, ${failed} failed → ${PDF_DIR}`);
await ctx.close();
