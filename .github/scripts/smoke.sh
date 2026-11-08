#!/usr/bin/env bash
# Boots a real host on this machine and checks the three things a person would
# check by hand: the service starts, the panel and the orchestrator answer, and
# verify-install reports the waiting-for-setup state. Used by
# .github/workflows/smoke.yml.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

profile=${SMOKE_PROFILE:-smoke}
port=${SMOKE_PORT:-3099}
work="${RUNNER_TEMP:-$(mktemp -d)}/superagent-smoke"
state="$work/state"
logs=(.artifacts/dsh-superagent-further-"$profile"-*.log)

fail() {
  echo "smoke: $*" >&2
  for log in "${logs[@]}"; do [ -f "$log" ] && tail -n 40 "$log"; done
  exit 1
}

echo "profile $profile, port $port, state $state"
dsh "$profile" --from-default-profile web --dump-config > /dev/null
mkdir -p "$work"
cat > "$HOME/.dsh/profiles/$profile/cordis.patch.yml" <<EOF
- id: webserver
  config:
    host: 127.0.0.1
    port: $port
- id: dsh-superagent-further
  config:
    stateDir: $state
EOF
dsh plugin --profile "$profile" add "link:$root" > /dev/null

set +e
node scripts/dsh-superagent-further start --profile "$profile" --url "http://127.0.0.1:$port"
started=$?
set -e
[ "$started" -eq 3 ] || fail "start exited $started, wanted 3 (waiting for setup)"

logs=(.artifacts/dsh-superagent-further-"$profile"-*.log)
token=$(grep -ho 'token=[A-Za-z0-9_-]*' "${logs[@]}" 2>/dev/null | tail -n 1 | cut -d= -f2)
[ -n "$token" ] || fail "no panel token in the log"

jar=$(mktemp)
curl -fsS -c "$jar" -o /dev/null "http://127.0.0.1:$port/?token=$token" || fail "the token URL did not answer"
curl -fsS -b "$jar" "http://127.0.0.1:$port/" | grep -q '__DSH_BOOT__' || fail "the panel did not serve its boot document"
curl -fsS -H 'x-orchestrator-request: 1' -H "authorization: Bearer $token" \
  "http://127.0.0.1:$port/orchestrator/api/state" | grep -q '"setup"' || fail "the orchestrator API did not answer"

set +e
node scripts/verify-install --profile "$profile" --url "http://127.0.0.1:$port" --dsh "$(command -v dsh)"
verified=$?
set -e
[ "$verified" -eq 2 ] || fail "verify-install exited $verified, wanted 2 (waiting for setup)"

node scripts/dsh-superagent-further stop --profile "$profile" --url "http://127.0.0.1:$port" > /dev/null
echo "smoke ok"
