// PoC 2: inspect a decision DETAIL page structure
// Run: node poc_detail.mjs
import { chromium } from '/Users/chumisfum/node_modules/playwright/index.mjs';

const url = process.argv[2] ??
  'https://putusan3.mahkamahagung.go.id/direktori/putusan/zaf1a4f6761f2d7c980f313134333037.html';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ locale: 'id-ID' })).newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => !document.title.toLowerCase().includes('just a moment'),
  { timeout: 30000 },
).catch(() => {});
console.log('✓ title:', await page.title());

const data = await page.evaluate(() => {
  const txt = (s) => document.querySelector(s)?.textContent.trim() ?? null;
  // table of ringkasan / detail fields
  const fields = {};
  for (const row of document.querySelectorAll('table tr, .table tr')) {
    const cells = row.querySelectorAll('td, th');
    if (cells.length === 2) {
      const k = cells[0].textContent.trim();
      const v = cells[1].textContent.trim().replace(/\s+/g, ' ').slice(0, 300);
      if (k) fields[k] = v;
    }
  }
  const links = [...document.querySelectorAll('a')]
    .map((a) => ({ text: a.textContent.trim().slice(0, 60), href: a.href }))
    .filter((l) => /pdf|download|unduh|doc/i.test(l.href + l.text));
  return {
    h1: txt('h1, h2'),
    fields,
    links,
    textSample: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500),
  };
});
console.log('H1:', data.h1);
console.log('FIELDS:', JSON.stringify(data.fields, null, 2));
console.log('DOWNLOAD LINKS:', JSON.stringify(data.links, null, 2));
console.log('TEXT SAMPLE:', data.textSample);
await browser.close();
