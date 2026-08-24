#!/usr/bin/env bash
#
# CI guard: prove .gitignore is actually protecting the repo.
#
# This is the automated version of the manual audit run before the first push.
# Four independent checks, because the failure modes are genuinely distinct and
# no single git command catches all of them:
#
#   A. A file .gitignore matches is nonetheless TRACKED
#      (someone ran `git add -f .env`).  -> git ls-files --ignored
#
#   B. A known-secret file is tracked REGARDLESS of ignore state
#      (someone deleted the `.env` rule AND committed `.env`; check A is blind
#      to this, because the file is no longer "ignored").  -> scan tracked list
#
#   C. A required ignore rule stopped matching
#      (someone weakened .gitignore; nothing has leaked YET, but the guardrail
#      is gone and the next `git add .` commits the secret).  -> check-ignore
#      MUST succeed for representative sensitive paths
#
#   D. An intentional exception stopped applying
#      (the `!.env.example` negation broke, so the committed env template — the
#      only thing documenting required vars — silently disappears).
#      -> check-ignore MUST fail for those, and they MUST stay tracked
#
# Runs from anywhere; operates on the repo root. Reports every violating
# category, then exits non-zero if any check failed.

set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
note() { printf '    - %s\n' "$1"; }

# --- A. No tracked file is matched by an ignore rule -------------------------
echo "[A] tracked files that .gitignore says should be ignored"
tracked_ignored="$(git ls-files --cached --ignored --exclude-standard)"
if [ -n "$tracked_ignored" ]; then
  echo "  FAIL: these tracked files match a .gitignore rule."
  echo "        Untrack them with: git rm --cached <file>"
  while IFS= read -r f; do note "$f"; done <<< "$tracked_ignored"
  fail=1
else
  echo "  ok"
fi

# --- B. No known-secret file is tracked, whatever the ignore rules say -------
echo "[B] secret-shaped files in the tracked set"
# .env and .env.<anything> (except the .env.example templates), private keys and
# key material by extension. Independent of .gitignore so a deleted rule can't
# hide an already-committed secret.
secret_tracked="$(git ls-files \
  | grep -E \
      -e '(^|/)\.env(\.[^/]*)?$' \
      -e '\.(pem|key|p12|pfx|keystore|jks)$' \
      -e '(^|/)id_(rsa|dsa|ecdsa|ed25519)$' \
  | grep -Ev '(^|/)\.env\.example$' || true)"
if [ -n "$secret_tracked" ]; then
  echo "  FAIL: secret-shaped files are committed to the repo:"
  while IFS= read -r f; do note "$f"; done <<< "$secret_tracked"
  fail=1
else
  echo "  ok"
fi

# --- C. Required ignore rules still match ------------------------------------
echo "[C] paths that MUST be ignored"
must_ignore=(
  ".env"
  ".env.production"
  ".env.local"
  "apps/web/.env.local"
  "node_modules/pkg/index.js"
  "packages/server/node_modules/pkg/index.js"
  "data/store.json"
  ".breadcrumbz/local-data/store.json"
  "secret.pem"
  "server.key"
  "state.local.json"
  "apps/web/dist/bundle.js"
)
c_fail=0
for p in "${must_ignore[@]}"; do
  # --no-index: test the ignore RULES, not the index. Without it, check-ignore
  # reports any tracked path as "not ignored" (index wins), which would both
  # mask a weakened rule and misfire on a path that happens to be tracked.
  if ! git check-ignore --no-index -q -- "$p"; then
    echo "  FAIL: '$p' is NOT ignored but must be (a .gitignore rule was weakened)"
    c_fail=1
    fail=1
  fi
done
[ "$c_fail" -eq 0 ] && echo "  ok"

# --- D. Intentional exceptions remain tracked and un-ignored -----------------
echo "[D] env templates that MUST stay tracked (the !.env.example exception)"
must_keep=(
  ".env.example"
  "apps/web/.env.example"
)
d_fail=0
for p in "${must_keep[@]}"; do
  # --no-index again: .env.example is tracked, so a plain check-ignore always
  # says "not ignored" (index wins) and could never detect a broken negation.
  if git check-ignore --no-index -q -- "$p"; then
    echo "  FAIL: '$p' is ignored but must stay tracked (the !.env.example negation broke)"
    d_fail=1
    fail=1
  elif ! git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    echo "  FAIL: '$p' is missing from the repo (the env template must be committed)"
    d_fail=1
    fail=1
  fi
done
[ "$d_fail" -eq 0 ] && echo "  ok"

echo
if [ "$fail" -ne 0 ]; then
  echo ".gitignore check FAILED — see the categories marked FAIL above."
  exit 1
fi
echo ".gitignore check passed."
