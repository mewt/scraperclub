#!/bin/bash
# Progress checker for scraper.mjs — run: ./progress.sh
# For a LIVE progress bar instead, run: node progress-bar.mjs
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${1:-$DIR/data/scraper.log}"
DATA="$DIR/data"

if [ ! -f "$LOG" ]; then
  echo "Status: NOT STARTED (no log at $LOG)"
  exit 0
fi

# --- overall status ---
if grep -q 'DONE — ' "$LOG"; then
  STATUS="✅ DONE"
elif pgrep -f 'node scraper.mjs' >/dev/null; then
  STATUS="🟢 RUNNING"
else
  STATUS="🔴 STOPPED (resume with: node scraper.mjs --delay 600)"
fi
echo "Status: $STATUS"
echo

# --- phase 1: listing crawl ---
LISTING_PAGES=$(grep -c 'entries (' "$LOG")
UNIQUE=$(grep -o '([0-9]* new)' "$LOG" | grep -o '[0-9]*' | awk '{s+=$1} END {print s+0}')
FAMILIES=$(grep -c 'family done:' "$LOG")
echo "Phase 1 — listing crawl:"
echo "  listing pages fetched : $LISTING_PAGES"
echo "  unique decisions found: $UNIQUE"
echo "  category families done: $FAMILIES"

# --- phase 2: detail scrape ---
TARGETS=$(grep 'targets: ' "$LOG" | tail -1 | sed 's/.*targets: //' )
TOGO=$(grep 'to scrape now: ' "$LOG" | tail -1 | sed 's/.*to scrape now: \([0-9]*\).*/\1/')
RECORDS=$(wc -l < "$DATA/putusan.jsonl" 2>/dev/null | tr -d ' ')
RECORDS=${RECORDS:-0}
if [ -n "$TOGO" ]; then
  echo
  echo "Phase 2 — detail pages ($TARGETS):"
  echo "  scraped this run: $RECORDS / $TOGO"
  if [ "$TOGO" -gt 0 ]; then
    PCT=$((RECORDS * 100 / TOGO))
    echo "  progress: $PCT%"
  fi
else
  echo
  echo "Phase 2 — details: not started yet (listing crawl still running)"
fi

echo
echo "Current time (GMT+7): $(TZ=Asia/Jakarta date '+%Y-%m-%d %H:%M:%S')"
AGE=$(( $(date +%s) - $(stat -f %m "$LOG") ))
echo "Last activity        : ${AGE}s ago"
echo
echo "Last log line (UTC+7):"
tail -1 "$LOG" | python3 -c "
import sys, datetime
line = sys.stdin.readline().rstrip('\n')
try:
    t = datetime.datetime.strptime(line.split(' ')[0], '%H:%M:%S')
    t += datetime.timedelta(hours=7)
    print(t.strftime('%H:%M:%S') + line[8:])
except Exception:
    print(line)
"