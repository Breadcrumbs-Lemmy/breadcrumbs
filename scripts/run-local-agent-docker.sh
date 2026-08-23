#!/usr/bin/env bash
#
# run-local-agent-docker.sh — stand up the fully-local, offline assistant on Docker.
#
# Brings up three containers using the base compose file plus the local-agent
# overlay (docker-compose.local-agent.yml):
#
#   ollama  the on-box model. Publishes NO host port — it is reachable only from
#           inside the compose network, so a working chat proves the API talked
#           to it privately at http://ollama:11434/v1.
#   api     the Fastify API on host :8787, wired to BREADCRUMBZ_AGENT_PROVIDER=local.
#   web     the React UI on a free host port (5173 is often held by a dev server,
#           so this script auto-picks the next free one).
#
# The model runs on THIS machine; a user's financial prompts never leave the host.
#
# CPU vs GPU:
#   By default the model runs on CPU. On a Linux host with an NVIDIA GPU + the
#   NVIDIA Container Toolkit (e.g. an AWS g4dn/g5/g6 EC2 instance) this script
#   auto-detects the GPU and layers docker-compose.gpu.yml so inference runs on
#   the GPU. On Docker Desktop for Mac/Windows the GPU is not exposed to the
#   container VM, so it stays CPU-only there — chat works but is slower, and PDF
#   *extraction* inference may exceed its 180s/chunk timeout (see the closing note).
#
# Usage:
#   ./scripts/run-local-agent-docker.sh                 # auto-detect CPU/GPU
#   ./scripts/run-local-agent-docker.sh --gpu           # force the GPU overlay
#   ./scripts/run-local-agent-docker.sh --cpu           # force CPU even on a GPU box
#   BREADCRUMBZ_LOCAL_AGENT_MODEL=qwen2.5:32b ./scripts/run-local-agent-docker.sh --gpu
#
set -euo pipefail

# --- Locate the repo root (this script lives in <root>/scripts) --------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Port check via lsof. On a minimal host without lsof we can't probe, so we
# treat every port as "free" and let `docker compose up` be the real arbiter
# (it fails loudly on a genuine bind conflict). HAVE_LSOF is set in preflight.
port_free() { $HAVE_LSOF || return 0; ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
# The nvidia runtime shows up in `docker info` once the Container Toolkit is
# wired into Docker — the best single predictor that a GPU reservation will work.
gpu_runtime_present() { docker info 2>/dev/null | grep -qiE 'nvidia'; }

# --- Args: --gpu / --cpu override the auto-detection (or set BREADCRUMBZ_GPU) --
case "${1:-}" in
  --gpu) BREADCRUMBZ_GPU=1 ;;
  --cpu) BREADCRUMBZ_GPU=0 ;;
  "")    ;;
  *)     die "Unknown argument: $1  (use --gpu, --cpu, or no argument to auto-detect)." ;;
esac

# --- Config ------------------------------------------------------------------
# Runnable default. The compose default is llama3.3:70b (~40GB VRAM, multi-GB
# pull); 8b is proven-correct on this project, fits the cheapest GPU (and any
# CPU box), and is already cached in the breadcrumbz-ollama-models volume, so it
# serves instantly. Exporting this var drives BOTH the ollama pull tag and the
# api's model — keeping them in lockstep.
MODEL="${BREADCRUMBZ_LOCAL_AGENT_MODEL:-llama3.1:8b}"
export BREADCRUMBZ_LOCAL_AGENT_MODEL="$MODEL"

API_PORT=8787

# --- Preflight ---------------------------------------------------------------
log "Preflight"
docker info >/dev/null 2>&1 || die "Docker daemon is not running. Start Docker Desktop and retry."
ok "Docker daemon is up"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2+ is required."
ok "Docker Compose $(docker compose version --short 2>/dev/null || echo present)"

# curl is required — every verification step below uses it. A fresh EC2 AMI may
# not ship it, in which case a healthy API would wrongly look unreachable.
command -v curl >/dev/null 2>&1 || die "curl is required (used to verify the API). Install it (e.g. 'sudo dnf install -y curl' / 'apt-get install -y curl') and retry."
ok "curl present"
# lsof is optional — used only for the pre-bind port probe. Without it we skip
# the probe and let 'compose up' catch a real conflict.
HAVE_LSOF=true
if ! command -v lsof >/dev/null 2>&1; then
  HAVE_LSOF=false
  warn "lsof not found — skipping the port pre-check (compose up will still fail loudly on a real conflict)."
fi

# Decide CPU vs GPU now that we know Docker is reachable.
GPU_FILES=()
case "${BREADCRUMBZ_GPU:-auto}" in
  1|true|yes|on)  USE_GPU=true ;;
  0|false|no|off) USE_GPU=false ;;
  *)              if gpu_runtime_present; then USE_GPU=true; else USE_GPU=false; fi ;;
esac
if $USE_GPU; then
  GPU_FILES=(-f docker-compose.gpu.yml)
  ok "GPU mode — reserving NVIDIA GPU(s) for ollama (docker-compose.gpu.yml)"
  if ! gpu_runtime_present; then
    warn "…but Docker's NVIDIA runtime was not detected. If 'up' fails, install the NVIDIA"
    warn "Container Toolkit: nvidia-ctk runtime configure --runtime=docker && restart docker."
  fi
else
  ok "CPU mode (no NVIDIA runtime detected — pass --gpu to force it on an NVIDIA host)"
fi

# Compose invocation: base + local-agent (+ gpu overlay when enabled).
# NOTE: "${GPU_FILES[@]+...}" — macOS ships bash 3.2, where expanding an EMPTY
# array (CPU mode) as a bare "${GPU_FILES[@]}" aborts under `set -u` with
# "unbound variable". This guarded form expands to nothing when empty.
BASE_COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.local-agent.yml "${GPU_FILES[@]+"${GPU_FILES[@]}"}")

port_free "$API_PORT" || die "Host port $API_PORT (api) is already in use. Stop the other process and retry."
ok "API port $API_PORT is free"

# Pick a free host port for the web UI (base compose hardcodes 5173, often busy).
WEB_PORT=""
for p in 5173 5273 5373 5473 5573; do
  if port_free "$p"; then WEB_PORT="$p"; break; fi
done
[ -n "$WEB_PORT" ] || die "No free web port in 5173..5573."
ok "Web UI will publish on host port $WEB_PORT"

# --- Additive port override for web (no edits to the backend-owned base file) -
# `!override` REPLACES the base `ports` list instead of appending to it, so we
# never try to bind the busy 5173 alongside the chosen port. This file only
# tweaks a port — it has no build context — so it is safe to keep in /tmp.
# NOTE: explicit "<dir>/<prefix>.XXXXXX" template — this is the ONE mktemp form
# that behaves identically on BSD (macOS) and GNU (Linux/EC2); `mktemp -t PREFIX`
# means different things on each. No file extension: `docker compose -f` parses
# any file as YAML regardless of name, and appending ".yml" to the result would
# leak the 0-byte file mktemp actually created (the trap would miss it).
WEB_OVERRIDE="$(mktemp "${TMPDIR:-/tmp}/breadcrumbz-web-port.XXXXXX")"
cat >"$WEB_OVERRIDE" <<YAML
services:
  web:
    ports: !override
      - "${WEB_PORT}:80"
YAML
trap 'rm -f "$WEB_OVERRIDE"' EXIT
COMPOSE=("${BASE_COMPOSE[@]}" -f "$WEB_OVERRIDE")

# --- Bring up the assistant (api + ollama) — the core of the request ---------
# Started on their own so a problem with the optional web image can never keep
# the assistant from coming up.
log "Building & starting api + ollama (model: $MODEL, $($USE_GPU && echo GPU || echo CPU))"
echo "  api image is cached; ollama serves $MODEL from the cached volume (no model download)."
"${BASE_COMPOSE[@]}" up -d --build api ollama

# --- Wait for the API to answer /health -------------------------------------
log "Waiting for the API /health"
api_up=false
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1; then api_up=true; break; fi
  sleep 3
done
$api_up || { warn "API did not become healthy in time. Recent api logs:"; "${BASE_COMPOSE[@]}" logs --tail=40 api; die "API unhealthy."; }
ok "API is healthy on http://localhost:${API_PORT}"

# --- Assert the assistant is wired to the LOCAL provider ---------------------
log "Assistant status  (GET /api/v1/agent/status)"
STATUS="$(curl -fsS "http://localhost:${API_PORT}/api/v1/agent/status")"
echo "$STATUS" | (python3 -m json.tool 2>/dev/null || cat) | sed 's/^/  /'
echo "$STATUS" | grep -q '"provider": *"local"'  && ok "provider = local (offline)"          || warn "provider is not local — check env"
echo "$STATUS" | grep -q '"configured": *true'   && ok "assistant configured"                 || warn "assistant not configured"
echo "$STATUS" | grep -q 'statement_extraction'  && ok "PDF statement extraction enabled"     || warn "statement extraction capability missing"

# --- Live chat round-trip ----------------------------------------------------
# ollama has no published host port, so a successful reply proves the API reached
# it privately over the compose network at http://ollama:11434/v1.
log "Live chat round-trip  (allowing up to 4 min — a cold CPU inference can be slow)"
CHAT_BODY='{"messages":[{"role":"user","content":"In one sentence, what can you help me do with my finances?"}]}'
if CHAT="$(curl -fsS --max-time 240 -H 'content-type: application/json' -d "$CHAT_BODY" "http://localhost:${API_PORT}/api/v1/agent/chat")"; then
  echo "$CHAT" | (python3 -m json.tool 2>/dev/null || cat) | sed 's/^/  /'
  ok "The local model answered — the API reached ollama over the private compose network (no host port published)."
else
  warn "Chat did not return within 4 minutes. The stack is UP; the first (cold) CPU inference for 8b can be slow."
  warn "Retry: curl -s -H 'content-type: application/json' -d '${CHAT_BODY}' http://localhost:${API_PORT}/api/v1/agent/chat"
fi

# --- Web UI (best-effort) ----------------------------------------------------
# The assistant is already up; the UI is a convenience. A failure here (e.g. a
# type error anywhere in the source the web bundle imports) must NOT tear down
# the running assistant, so this step is non-fatal.
log "Building & starting the web UI on host port $WEB_PORT"
web_up=false
if "${COMPOSE[@]}" up -d --build web; then
  web_up=true
  ok "Web UI is up on http://localhost:${WEB_PORT}"
else
  warn "The web image failed to build (see output above). The assistant (api) is unaffected"
  warn "and fully usable over HTTP. Fix the reported error and re-run to get the UI."
fi

# --- Summary -----------------------------------------------------------------
COMPOSE_STR="docker compose -f docker-compose.yml -f docker-compose.local-agent.yml$($USE_GPU && echo ' -f docker-compose.gpu.yml' || true)"
log "Ready"
{
  echo "  API    : http://localhost:${API_PORT}      health: /health   status: /api/v1/agent/status"
  $web_up && echo "  Web UI : http://localhost:${WEB_PORT}"
  echo "  Model  : ${MODEL}   ($($USE_GPU && echo 'GPU' || echo 'CPU') · local / offline — prompts never leave this machine)"
  echo
  if $USE_GPU; then
    echo "  Running on GPU. To fit a bigger model, set BREADCRUMBZ_LOCAL_AGENT_MODEL to a tier"
    echo "  your card's VRAM allows (see docker-compose.gpu.yml) and re-run — larger cards cost more."
  else
    echo "  Running on CPU. On a Mac, PDF *extraction* inference may exceed its 180s timeout;"
    echo "  chat works but is slower than native Ollama. For fast extraction, run Ollama natively"
    echo "  (Metal GPU) and point BREADCRUMBZ_LOCAL_AGENT_BASE_URL at it — or deploy on an NVIDIA"
    echo "  host and re-run with --gpu. See the 'Deploying on EC2' note in docker-compose.local-agent.yml."
  fi
  echo
  echo "  Logs : ${COMPOSE_STR} logs -f api ollama"
  echo "  Stop : ${COMPOSE_STR} down"
}
