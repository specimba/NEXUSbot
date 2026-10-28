#!/bin/bash
# rsi-conv-realism watcher — waits out the z-ai gateway throttle window and
# auto-resumes the parked cycle-2 (conversation-realism-v36) the moment a
# probe call succeeds. The driver itself is fully resumable (engine stage
# statuses are the source of truth) and already backs off patienty at
# synthesize + retries 429s inside the judge.
#
# Rationale: running a paired battery against a throttled judge would poison
# verdicts with infra noise — the honest path is to wait for a healthy window.
cd /home/z/my-project

LOG=/tmp/rsi-conv-realism.log
PROBE='
const ZAI = (await import("z-ai-web-dev-sdk")).default;
const zai = await ZAI.create();
await zai.chat.completions.create({ messages: [{ role: "user", content: "ok" }] });
console.log("PROBE_OK");
'

echo "[$(date -u '+%Y-%m-%d %H:%M:%S') UTC] watcher armed — probing z-ai every 600s (up to 54 attempts ≈ 9h)" >> "$LOG"

for i in $(seq 1 54); do
  if bun -e "$PROBE" >> "$LOG" 2>&1; then
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S') UTC] z-ai reachable on attempt $i — launching the cycle driver (resumes at its current stage)" >> "$LOG"
    exec bun scripts/rsi-conv-realism.ts >> "$LOG" 2>&1
  fi
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S') UTC] probe $i: z-ai throttled — sleeping 600s" >> "$LOG"
  sleep 600
done

echo "[$(date -u '+%Y-%m-%d %H:%M:%S') UTC] watcher gave up after 54 attempts — cycle stays parked; advance manually when the gateway is healthy" >> "$LOG"
exit 1
