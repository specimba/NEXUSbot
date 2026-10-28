#!/bin/bash
# cron-20261028-2025 — verify v36.2 edge straggler fix + local headroom.
# LOCAL panel probes only (sender nx-probe; probe calls never post to Kick).
# Expect: no STATIC floor, edge/vyce wins, latency well under the old
# 12.4-15.5s band now that the edge ships at decision+≤400ms.
probe() {
  local label="$1"; local body="$2"
  echo "=== $label ==="
  local t0=$(date +%s%3N)
  curl -s --max-time 30 -b /tmp/nx-cookies.txt -X POST http://localhost:3000/api/brain/cortex \
    -H 'Content-Type: application/json' -d "$body" \
    -o /tmp/nx-probe-out.json -w "http:%{http_code}\n"
  local t1=$(date +%s%3N)
  echo "wall=$((t1 - t0))ms"
  python3 -c "import json;d=json.load(open('/tmp/nx-probe-out.json'));print(json.dumps({k:d.get(k) for k in ('modelLabel','provider','modelId','intent')},ensure_ascii=False)[:300]);print('reply:',(d.get('reply') or d.get('fallbackLine') or '')[:140])" 2>/dev/null || head -c 300 /tmp/nx-probe-out.json
  echo
}
probe "banter (race path, expect <14s real engine)" \
  '{"sender":"nx-probe","prompt":"selam kankalar naber","channel":"specimba"}'
sleep 9
probe "memory question (attitude class, expect warm honest CHAT)" \
  '{"sender":"nx-probe","prompt":"beni hatırlıyor musun","channel":"specimba"}'
sleep 9
probe "banter-2 (race path repeat)" \
  '{"sender":"nx-probe","prompt":"bugun cok sıkkınsın valla","channel":"specimba"}'
