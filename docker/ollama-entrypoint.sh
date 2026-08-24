#!/bin/sh
# Ollama sidecar entrypoint: serve, and pull the model once into the volume.
#
# The weights live on the `ollama-models` volume, so the multi-GB download only
# happens on the very first boot. On every boot after that the model is already
# cached and this script goes straight to serving — which is what lets the serving
# network be locked down to no-internet (see docker-compose.local-agent.yml): the
# pull needs egress, but serving from the cached volume does not.
set -e

# Trim surrounding whitespace so a padded env var can't make the sidecar pull a
# tag the API never requests: config.ts .trim()s the same values before sending
# them as the Ollama request's model, so an untrimmed pull here would 404 on
# every boot. Model tags carry no internal spaces, so stripping all whitespace is
# safe. (Docker Compose's own .env parser already strips, so this only matters
# when the vars are exported from a shell — but the asymmetry is worth closing.)
MODEL="$(printf '%s' "${OLLAMA_MODEL:-llama3.1:8b}" | tr -d '[:space:]')"
# Optional second model, pulled only when the deployment splits chat and
# statement extraction across two models (BREADCRUMBZ_LOCAL_EXTRACTION_MODEL).
# Empty, or equal to MODEL, means the single-model setup — nothing extra pulled.
EXTRACTION_MODEL="$(printf '%s' "${OLLAMA_EXTRACTION_MODEL:-}" | tr -d '[:space:]')"

# Start the daemon in the background so we can pull against it, then hand the
# foreground back to it so the container's lifetime tracks the server.
ollama serve &
serve_pid=$!

# Wait for the daemon to accept connections before pulling.
echo "ollama: waiting for daemon..."
until ollama list >/dev/null 2>&1; do
  sleep 1
done

# Pull one model only if THIS EXACT name:tag is missing from the volume. Match
# the full name:tag (column 1 of `ollama list`, e.g. "llama3.1:8b"), not just the
# repo prefix: a prefix match ("llama3.1") would treat a cached llama3.1:8b as
# satisfying a request for llama3.1:70b, skip the pull, and then serve the wrong
# weights while the API's requests 404 with "model not found". `-x -F` matches
# the whole field literally, so the `:`/`.` in the tag aren't treated as regex.
ensure_model() {
  want="$1"
  if ollama list | awk '{print $1}' | grep -qxF "${want}"; then
    echo "ollama: ${want} already cached — serving offline."
  else
    echo "ollama: pulling ${want} (first run downloads several GB — needs internet)..."
    ollama pull "${want}"
  fi
}

ensure_model "${MODEL}"
# The extraction model is pulled only when it is set AND distinct from the chat
# model, so the single-model path downloads nothing extra.
if [ -n "${EXTRACTION_MODEL}" ] && [ "${EXTRACTION_MODEL}" != "${MODEL}" ]; then
  ensure_model "${EXTRACTION_MODEL}"
  echo "ollama: ready, serving ${MODEL} (chat) + ${EXTRACTION_MODEL} (extraction)."
else
  echo "ollama: ready, serving ${MODEL}."
fi

wait "$serve_pid"
