#!/usr/bin/env bash
# R12 integration verification — P7: secrets never printed.
set -uo pipefail
cd /home/z/my-project
PW=$(grep '^PANEL_PASSWORD=' .env | cut -d= -f2-)
JAR=$(mktemp)
CODE=$(curl -s -c "$JAR" -o /tmp/login.json -w '%{http_code}' -X POST http://127.0.0.1:3000/api/auth/login -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}")
if [ "$CODE" != "200" ] || ! grep -q 'ok.*true' /tmp/login.json; then echo "LOGIN: FAILED ($CODE)"; exit 9; fi
echo "LOGIN: ok"
A=(-b "$JAR")

jqget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(eval(sys.argv[1]),default=str))" "$1" 2>/dev/null || echo "PARSE-FAIL"; }

echo "=== 1. WEBSHARE STATUS (400 fix check) ==="
curl -s -H "Accept: application/json" "${A[@]}" http://127.0.0.1:3000/api/connectors/webshare/status | jqget "{'configured':d.get('configured'),'apiOk':d.get('apiOk'),'count':d.get('count'),'validCount':d.get('validCount'),'error':d.get('error')}"

echo "=== 2. EGRESS PROBE groq (direct vs proxied) ==="
curl -s -X POST -H "Accept: application/json" "${A[@]}" -H 'Content-Type: application/json' -d '{"target":"groq"}' http://127.0.0.1:3000/api/egress/probe | jqget "d"

echo "=== 3. VYCE fake-key roundtrip ==="
curl -s -X PUT -H "Accept: application/json" "${A[@]}" -H 'Content-Type: application/json' -d '{"key":"vyce_fake_0123456789abcdef"}' http://127.0.0.1:3000/api/vyce/key | jqget "d"
curl -s -H "Accept: application/json" "${A[@]}" http://127.0.0.1:3000/api/vyce/status | jqget "{'configured':d.get('configured'),'connected':d.get('connected'),'error':d.get('error'),'masked':d.get('maskedKey')}"
curl -s -X DELETE -H "Accept: application/json" "${A[@]}" http://127.0.0.1:3000/api/vyce/key | jqget "d"

echo "=== 4. USAGE aggregates ==="
curl -s -H "Accept: application/json" "${A[@]}" http://127.0.0.1:3000/api/usage | jqget "d"

echo "=== 5. GITHUB status (12-b contract) ==="
curl -s -H "Accept: application/json" "${A[@]}" http://127.0.0.1:3000/api/github/status | jqget "{'appConfigured':d.get('appConfigured'),'credentialSource':d.get('credentialSource'),'connected':d.get('connected'),'callbackUrl':d.get('callbackUrl'),'tokenMirror':d.get('tokenMirror')}"

echo "=== 6. BACKUP status (12-d contract) ==="
curl -s -H "Accept: application/json" "${A[@]}" http://127.0.0.1:3000/api/backup/status | jqget "{'ok':d.get('ok'),'lastResult':d.get('lastResult'),'head':(d.get('head') or '')[:12],'tag':d.get('tag'),'tokenPresent':d.get('tokenPresent'),'remoteConfigured':d.get('remoteConfigured')}"

echo "=== 7. SUPABASE + UPSTASH + HYPERBROWSER quick ==="
curl -s -H "Accept: application/json" "${A[@]}" http://127.0.0.1:3000/api/connectors/supabase/status | jqget "{'configured':d.get('configured'),'connected':d.get('connected')}"
curl -s -H "Accept: application/json" "${A[@]}" http://127.0.0.1:3000/api/connectors/upstash/status | jqget "{'configured':d.get('configured'),'connected':d.get('connected')}"
curl -s -H "Accept: application/json" "${A[@]}" http://127.0.0.1:3000/api/connectors/hyperbrowser/status | jqget "{'configured':d.get('configured'),'connected':d.get('connected')}"
echo "=== DONE ==="
