#!/bin/bash
# Ensure the Next.js dev server is serving :3000 (harness reaps user processes
# between agent tool calls; boot path auto-starts this script via /start.sh).
cd /home/z/my-project
if curl -s -o /dev/null --max-time 3 http://localhost:3000/; then
  echo "[ensure-dev] already up"
else
  echo "[ensure-dev] starting dev server…"
  setsid nohup .zscripts/dev.sh > /home/z/my-project/dev.log 2>&1 < /dev/null &
  echo $! > .zscripts/dev.pid
  disown
  for i in $(seq 1 20); do
    sleep 1
    if curl -s -o /dev/null --max-time 3 http://localhost:3000/; then echo "[ensure-dev] up (attempt $i)"; exit 0; fi
  done
  echo "[ensure-dev] FAILED to start"; exit 1
fi
