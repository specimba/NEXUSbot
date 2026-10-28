#!/bin/bash
# cron-20261028-1625 — re-probe with 9s gaps (per-sender min gap = 8s)
probe() {
  local label="$1"; local body="$2"
  echo "=== $label ==="
  curl -s --max-time 30 -b /tmp/nx-cookies.txt -X POST http://localhost:3000/api/brain/cortex \
    -H 'Content-Type: application/json' -d "$body" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps({k:d.get(k) for k in ('route','modelLabel','provider','intent','telemetry','reply')},ensure_ascii=False)[:800])"
  echo
}
probe "bot-meta-command (expect CHAT race, NOT cortex-research)" \
  '{"sender":"nx-probe","prompt":"nasıl komut veriyorsun","channel":"specimba"}'
sleep 9
probe "praise-command (expect short banter, no salad)" \
  '{"sender":"nx-probe","prompt":"Aferin, adam ol","channel":"specimba"}'
sleep 9
probe "bare-fragment (expect honest unknown, no invented greeting)" \
  '{"sender":"nx-probe","prompt":"kurcuklan","channel":"specimba"}'
