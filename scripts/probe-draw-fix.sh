#!/bin/bash
# cron-20261028-1625 — verify draw-anti-hijack fix against the LIVE route.
# 1) real draw request seeds a cortex-draw resultTrail entry (no image spend:
#    probe caller simply ignores drawSubject; nothing posts to Kick)
# 2) banter "gücünü topla adam ol" must now return cortex-chat, NOT cortex-draw
# 3) regression: "bana bir adam çiz" must still return cortex-draw
probe() {
  local label="$1"; local body="$2"
  echo "=== $label ==="
  curl -s --max-time 30 -b /tmp/nx-cookies.txt -X POST http://localhost:3000/api/brain/cortex \
    -H 'Content-Type: application/json' -d "$body" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps({k:d.get(k) for k in ('route','modelLabel','drawSubject','reply')},ensure_ascii=False)[:400])"
  echo
}
probe "seed: real draw (expect cortex-draw)" \
  '{"sender":"nx-probe","prompt":"arap çiz","channel":"specimba"}'
sleep 9
probe "banter after draw (expect cortex-chat — THE FIX)" \
  '{"sender":"nx-probe","prompt":"gücünü topla adam ol","channel":"specimba"}'
sleep 9
probe "regression: real draw still works (expect cortex-draw)" \
  '{"sender":"nx-probe","prompt":"bana bir adam çiz","channel":"specimba"}'
