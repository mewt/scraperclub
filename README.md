# putusan3-scraper

Scraper for **PK (Peninjauan Kembali) tax decisions** from the Indonesian Supreme Court's public decision database — [putusan3.mahkamahagung.go.id](https://putusan3.mahkamahagung.go.id).

It crawls the `Pajak` / `Pajak-2` categories (and their tax subcategories), filters PK cases by case number (`…/PK/Pjk/…`), and collects full metadata for each decision: nomor, para pihak, amar + catatan amar, kaidah, hakim, status, dates, and the PDF/ZIP download links.

## Requirements

- **Node.js ≥ 18**
- **Google Chrome** installed (used via Playwright's `channel: 'chrome'`)

## Install

```bash
git clone <this-repo>
cd putusan3-scraper
npm install
```

That's it — `npm install` pulls the two dependencies (`playwright-core`, `cli-progress`).

## Usage

```bash
# 1. run the scraper (resumable — safe to stop and re-run at any time)
npm run scrape

# 2. watch progress in another terminal
npm run progress        # live progress bar (cli-progress)
npm run progress:quick  # one-shot text snapshot

# 3. download the PDFs of all collected decisions
npm run pdf
```

### Options (scraper)

| flag | meaning |
|---|---|
| `--all` | keep non-PK decisions too (default: PK only) |
| `--pdf` | download PDFs inline while scraping |
| `--workers N` | parallel detail pages (default 2) |
| `--delay MS` | pause between requests per worker (default 800) |
| `--limit N` | stop after N detail pages (testing) |
| `--max-listing-pages N` | cap the listing crawl (testing) |
| `--recrawl` | ignore the `data/listings.json` cache |

Environment: `PUTUSAN_DATA=/some/dir` changes where output is written (default `./data`).

## Output (in `./data`)

| file | content |
|---|---|
| `putusan.jsonl` | one JSON record per decision (all fields) |
| `putusan.csv` | flat CSV export of the same records |
| `listings.json` | cached listing index (skips re-crawling listings on resume) |
| `scraper.log` | log of the current run (read by the progress tools) |
| `pdf/*.pdf` | downloaded decision PDFs |

## How it works

1. **Listing crawl** — enumerates every `pajak*` category page through both URL styles the site uses (`slug-N.html` and `slug/page/N.html`), walking to the real last page from the pagination. Deterministic — one failed page cannot break the crawl; failures are retried at the end.
2. **Detail scrape** — pre-filters PK cases from the listing titles, then scrapes each decision's detail table. Skips URLs already present in `putusan.jsonl`, so runs resume where they left off.
3. **PDF pass** — fetches each record's `pdf_url` (resumable, existing files skipped).

The browser uses a persistent profile (`data/.chrome-profile`) so the Cloudflare clearance cookie survives across runs.

## Notes

- Data comes from a public government website; keep the default delay and worker counts reasonable.
- The site's Cloudflare challenge appears in both English and Indonesian — both are handled.
- `poc/` contains the original proof-of-concept scripts kept for reference.

## License

MIT