#!/bin/bash

set -euo pipefail

# 获取脚本所在目录（.zscripts）
# 使用 $0 获取脚本路径（与 build.sh 保持一致）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step_start() {
        local step_name="$1"
        echo "=========================================="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting: $step_name"
        echo "=========================================="
        export STEP_START_TIME
        STEP_START_TIME=$(date +%s)
}

log_step_end() {
        local step_name="${1:-Unknown step}"
        local end_time
        end_time=$(date +%s)
        local duration=$((end_time - STEP_START_TIME))
        echo "=========================================="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Completed: $step_name"
        echo "[LOG] Step: $step_name | Duration: ${duration}s"
        echo "=========================================="
        echo ""
}

start_mini_services() {
        local mini_services_dir="$PROJECT_DIR/mini-services"
        local started_count=0

        log_step_start "Starting mini-services"
        if [ ! -d "$mini_services_dir" ]; then
                echo "Mini-services directory not found, skipping..."
                log_step_end "Starting mini-services"
                return 0
        fi

        echo "Found mini-services directory, scanning for sub-services..."

        for service_dir in "$mini_services_dir"/*; do
                if [ ! -d "$service_dir" ]; then
                        continue
                fi

                local service_name
                service_name=$(basename "$service_dir")
                echo "Checking service: $service_name"

                if [ ! -f "$service_dir/package.json" ]; then
                        echo "[$service_name] No package.json found, skipping..."
                        continue
                fi

                if ! grep -q '"dev"' "$service_dir/package.json"; then
                        echo "[$service_name] No dev script found, skipping..."
                        continue
                fi

                echo "Starting $service_name in background..."
                (
                        cd "$service_dir"
                        echo "[$service_name] Installing dependencies..."
                        bun install
                        echo "[$service_name] Running bun run dev..."
                        exec bun run dev
                ) >"$PROJECT_DIR/.zscripts/mini-service-${service_name}.log" 2>&1 &

                local service_pid=$!
                echo "[$service_name] Started in background (PID: $service_pid)"
                echo "[$service_name] Log: $PROJECT_DIR/.zscripts/mini-service-${service_name}.log"
                disown "$service_pid" 2>/dev/null || true
                started_count=$((started_count + 1))
        done

        echo "Mini-services startup completed. Started $started_count service(s)."
        log_step_end "Starting mini-services"
}

wait_for_service() {
        local host="$1"
        local port="$2"
        local service_name="$3"
        local max_attempts="${4:-60}"
        local attempt=1

        echo "Waiting for $service_name to be ready on $host:$port..."

        while [ "$attempt" -le "$max_attempts" ]; do
                if curl -s --connect-timeout 2 --max-time 5 "http://$host:$port" >/dev/null 2>&1; then
                        echo "$service_name is ready!"
                        return 0
                fi

                echo "Attempt $attempt/$max_attempts: $service_name not ready yet, waiting..."
                sleep 1
                attempt=$((attempt + 1))
        done

        echo "ERROR: $service_name failed to start within $max_attempts seconds"
        return 1
}

cleanup() {
        if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" >/dev/null 2>&1; then
                echo "Stopping Next.js dev server (PID: $DEV_PID)..."
                kill "$DEV_PID" >/dev/null 2>&1 || true
        fi
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

# P7 durable env: /start.sh rewrites .env to DATABASE_URL-only on every cold boot.
# Re-bootstrap any missing keys (values generated in-place, never printed).
bash scripts/ensure-env.sh || true

if ! command -v bun >/dev/null 2>&1; then
        echo "ERROR: bun is not installed or not in PATH"
        exit 1
fi

log_step_start "bun install"
echo "[BUN] Installing dependencies..."
bun install
log_step_end "bun install"

log_step_start "bun run db:push"
echo "[BUN] Setting up database..."
bun run db:push
log_step_end "bun run db:push"

log_step_start "Starting Next.js dev server"
# 2026-10-29 cron-20261029-0025 root-cause fix: the sandbox suspend/resume
# cycle can freeze .next/dev (turbopack incremental cache) mid-write; on the
# next boot every PAGE then 500s with a bare "Internal Server Error" (API
# routes fine, no request logged). Measured consequence chain this boot
# (16:25:40): dev.sh health check failed -> set -e killed dev.sh BEFORE
# start_mini_services -> mem-watchdog starved for the whole session (panel
# unguarded). Deterministic pre-start purge costs one cold compile (~10s) and
# kills the whole failure class, for both boot-time and watchdog respawns.
rm -rf "$PROJECT_DIR/.next/dev"
echo "[BUN] Starting development server..."
bun run dev &
DEV_PID=$!
log_step_end "Starting Next.js dev server"

# 2026-10-29 starvation fix (measured TWICE: boots of 10-28 16:25 and 16:35 —
# both times set -e killed dev.sh at the health gate, start_mini_services
# never ran, kick-bridge :3010 stayed down the whole session and the live
# Kick bot got NO_CHATROOM on every send; the orphaned next-server kept
# serving, so the panel LOOKED healthy). The health gates below are now
# ADVISORY: a failed check logs a warning and the script continues so
# mini-services ALWAYS start. mem-watchdog (started by start_mini_services)
# owns respawning a dead dev server — but it can only do that if it exists.
log_step_start "Waiting for Next.js dev server"
if wait_for_service "localhost" "3000" "Next.js dev server"; then
        log_step_end "Waiting for Next.js dev server"
else
        echo "WARN: dev server not healthy within the wait window — CONTINUING so mini-services still start (mem-watchdog will respawn the panel if it stays down)."
        log_step_end "Waiting for Next.js dev server"
fi

log_step_start "Health check"
if curl -fsS localhost:3000 >/dev/null; then
        echo "[BUN] Health check passed"
else
        echo "WARN: health check failed — CONTINUING so mini-services still start (mem-watchdog owns the respawn)."
fi
log_step_end "Health check"

start_mini_services

echo "Next.js dev server is running in background (PID: $DEV_PID)."
echo "Use 'kill $DEV_PID' to stop it."
disown "$DEV_PID" 2>/dev/null || true
unset DEV_PID
