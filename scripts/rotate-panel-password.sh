#!/usr/bin/env bash
# NEXUS OS — rotate the panel login password (PANEL_PASSWORD in .env).
# P7 rule: prints key NAMES only. The new value is written in-place, never echoed.
# After rotating: restart the dev server, then re-download the workspace to read .env.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo ".env missing — run scripts/ensure-env.sh first" >&2
  exit 1
fi

NEW="$(openssl rand -hex 16)"

if cut -d= -f1 .env | grep -qx 'PANEL_PASSWORD'; then
  tmp="$(mktemp)"
  awk -v k="PANEL_PASSWORD=$NEW" 'BEGIN{done=0} /^PANEL_PASSWORD=/{print k; done=1; next} {print} END{if(!done) print k}' .env > "$tmp"
  mv "$tmp" .env
else
  printf 'PANEL_PASSWORD=%s\n' "$NEW" >> .env
fi

echo "rotated PANEL_PASSWORD (value written to .env, not displayed here)"
echo "next steps: restart dev server; re-download workspace; open .env to read the new value"
