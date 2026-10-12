// PoC: can we scrape putusan3.mahkamahagung.go.id (Cloudflare-protected)?
// Run: node poc.mjs [url]
import { chromium } from '/Users/chumisfum/node_modules/playwright/index.mjs';

const url = process.argv[2] ??
  'https://putusan3.mahkamahagung.go.id/direktori/index/pengadilan/mahkamah-agung/kategori/pajak.html';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  locale: 'id-ID',
});
const page = await ctx.newPage();

console.log('→ loading', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait out the Cloudflare challenge (title flips from "Just a moment..." to real page)
try {
  await page.waitForFunction(
    () => !document.title.toLowerCase().includes('just a moment'),
    { timeout: 30000 },
  );
} catch {
  console.log('⚠ still on challenge page after 30s. Title:', await page.title());
}
console.log('✓ page title:', await page.title());

// Dump the listing rows
const rows = await page.evaluate(() => {
  const out = [];
  // putusan3 directory lists decisions in table rows / list items linking to detail pages
  for (const a of document.querySelectorAll('a[href*="/putusan/"], a[href*="detail"]')) {
    const text = a.textContent.trim().replace(/\s+/g, ' ');
    if (text) out.push({ text: text.slice(0, 120), href: a.href });
    if (out.length >= 30) break;
  }
  return out;
});

console.log(`✓ found ${rows.length} decision links (first 30):`);
for (const r of rows) console.log('  -', r.text, '|', r.href);

// Show pagination structure
const pag = await page.evaluate(() =>
  [...document.querySelectorAll('a')]
    .map((a) => a.getAttribute('href') || '')
    .filter((h) => /pajak-\d+\.html|page|start|offset/i.test(h))
    .slice(0, 10),
);
console.log('✓ pagination-like links:', pag);

// Save full HTML for structural analysis
const html = await page.content();
const { writeFileSync } = await import('node:fs');
writeFileSync('/Users/chumisfum/scraperclub/poc_page.html', html);
console.log('✓ saved page HTML to poc_page.html (', html.length, 'bytes )');

await browser.close();
console.log('DONE');
