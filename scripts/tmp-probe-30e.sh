#!/usr/bin/env bash
# TEMP probe (Task 30-e, HTTP leg) — the Kick routes against the LIVE dev server.
# Deleted after verification. P7: the panel password never appears in the
# process list (login body written to a temp file by bun, file deleted after).
set -uo pipefail
cd /home/z/my-project

BASE="http://127.0.0.1:3000"
JAR="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$JAR" "$BODY"' EXIT
fails=0
check() { if [ "$2" = "1" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+ — $3}"; fails=$((fails+1)); fi; }

# --- auth posture without a session ------------------------------------------
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/kick/status")
[ "$code" = "401" ]; check "http: status without session → 401" $? "got $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kick/state")
[ "$code" = "401" ]; check "http: state mint without session → 401" $? "got $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kick/webhook" -H "Content-Type: application/json" -d '{}')
[ "$code" = "401" ]; check "http: webhook ingest with garbage headers → 401" $? "got $code"

loc=$(curl -s -o /dev/null -w "%{redirect_url}" "$BASE/api/kick/callback?code=x&state=bogus")
[[ "$loc" == *"kick=error"* && "$loc" == *"reason=state_expired"* ]]; check "http: callback bogus state → 302 /?kick=error&reason=state_expired" $? "loc=$loc"

# --- login (P7-safe) ----------------------------------------------------------
bun -e 'const fs=require("fs");fs.writeFileSync(process.argv[1], JSON.stringify({password: process.env.PANEL_PASSWORD}));' "$BODY" || exit 1
code=$(curl -s -o /dev/null -w "%{http_code}" -c "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" --data-binary @"$BODY")
[ "$code" = "200" ]; check "http: panel login (cookie jar)" $? "got $code"

req() { # req <method> <path> [data-file-or-inline]
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    if [ -f "$data" ]; then
      curl -s -b "$JAR" -X "$method" "$BASE$path" -H "Content-Type: application/json" --data-binary @"$data"
    else
      curl -s -b "$JAR" -X "$method" "$BASE$path" -H "Content-Type: application/json" -d "$data"
    fi
  else
    curl -s -b "$JAR" -X "$method" "$BASE$path"
  fi
}

# --- state machine: NOT CONFIGURED → APP READY → mint → cleanup ---------------
st=$(req GET /api/kick/status)
[ "$(echo "$st" | jq -r '.status.configured')" = "false" ] && [ "$(echo "$st" | jq -r '.status.connected')" = "false" ] && [ "$(echo "$st" | jq -r '.status.chatReplies')" = "true" ]
check "http: status (session) → NOT CONFIGURED + replies default ON" $?
[[ "$(echo "$st" | jq -r '.status.redirectUri')" == *"/api/kick/callback" ]] && [ "$(echo "$st" | jq -r '.status.scopes | length')" = "4" ]
check "http: status exposes redirect URL + 4 scope hints" $?

printf '{"clientId":"probe-client-id-0123456789","clientSecret":"probe-secret-0123456789abcdef"}' > "$BODY"
save=$(req PUT /api/kick/app "$BODY")
[ "$(echo "$save" | jq -r '.masked.clientSecretMasked')" = "••••" ] && [ "$(echo "$save" | jq -r '.masked.clientIdMasked')" = "••••tkey-id" ]
check "http: save app creds → masked previews (secret never echoed)" $?

st=$(req GET /api/kick/status)
[ "$(echo "$st" | jq -r '.status.configured')" = "true" ] && [ "$(echo "$st" | jq -r '.status.connected')" = "false" ]
check "http: status now APP READY (configured, not connected)" $?

mint=$(req POST /api/kick/state)
[[ "$(echo "$mint" | jq -r '.authorizeUrl')" == "https://id.kick.com/oauth/authorize?"* ]]
check "http: state mint returns id.kick.com authorize URL" $?
[[ "$(echo "$mint" | jq -r '.authorizeUrl')" == *"code_challenge_method=S256"* ]]
check "http: authorize URL carries PKCE S256" $?

code=$(req PUT /api/kick/app '{"clientId":"short","clientSecret":"x"}' -o /dev/null -w "%{http_code}" 2>/dev/null)
st400=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/kick/app" -H "Content-Type: application/json" -d '{"clientId":"short","clientSecret":"x"}')
[ "$st400" = "400" ]; check "http: app validation rejects short creds → 400" $? "got $st400"

req DELETE /api/kick/app > /dev/null
st=$(req GET /api/kick/status)
[ "$(echo "$st" | jq -r '.status.configured')" = "false" ] && [ "$(echo "$st" | jq -r '.status.connected')" = "false" ]
check "http: app DELETE wipes vault → honest NOT CONFIGURED for the owner" $?

echo
[ "$fails" = "0" ] && echo "HTTP PROBES PASS" || echo "$fails HTTP PROBE(S) FAILED"
exit $fails
