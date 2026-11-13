#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/the-club"
API_ENV="$CONFIG_DIR/api.env"
REFRESH_ENV="$CONFIG_DIR/refresh.env"
KEYCLOAK_ENV="$ROOT_DIR/deploy/keycloak/.env"
WEB_ENV="$ROOT_DIR/web/.env.local"
SKIP_KEYCLOAK=false
SKIP_REFRESH=false
LOCAL_PIDS=()

usage() {
  printf 'Usage: %s [--no-keycloak] [--no-refresh]\n' "${0##*/}"
}

die() {
  printf 'local-start: %s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --no-keycloak) SKIP_KEYCLOAK=true ;;
    --no-refresh) SKIP_REFRESH=true ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

[[ -x "$ROOT_DIR/node_modules/.bin/tsx" ]] || die "Dependencies are missing; run npm ci first."
[[ -f "$API_ENV" ]] || die "Missing $API_ENV; copy deploy/api.env.example there and configure it."
[[ -f "$REFRESH_ENV" ]] || die "Missing $REFRESH_ENV; copy deploy/systemd/user/refresh.env.example there and configure it."
command -v curl >/dev/null || die "curl is required for local service readiness checks."

if [[ ! -f "$WEB_ENV" ]]; then
  cp "$ROOT_DIR/web/.env.example" "$WEB_ENV"
  printf 'Created %s from the web environment example.\n' "$WEB_ENV"
fi

if [[ "$SKIP_KEYCLOAK" == false ]]; then
  [[ -f "$KEYCLOAK_ENV" ]] || die "Missing $KEYCLOAK_ENV; copy deploy/keycloak/.env.example there and set a local admin password."
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v podman >/dev/null && podman compose version >/dev/null 2>&1; then
    COMPOSE=(podman compose)
  else
    die "Docker Compose or Podman Compose is required to start local Keycloak."
  fi
fi

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  for pid in "${LOCAL_PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${LOCAL_PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_url() {
  local url="$1"
  local service="$2"
  for ((attempt = 0; attempt < 90; attempt++)); do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "$service did not become ready at $url."
}

user_unit_matches_checkout() {
  local unit="$1"
  local unit_directory
  [[ "$CONFIG_DIR" == "$HOME/.config/the-club" ]] || return 1
  command -v systemctl >/dev/null || return 1
  systemctl --user cat "$unit" >/dev/null 2>&1 || return 1
  unit_directory="$(systemctl --user show "$unit" --property=WorkingDirectory --value 2>/dev/null || true)"
  [[ "$unit_directory" == "$ROOT_DIR" ]]
}

start_local_api() {
  (
    cd "$ROOT_DIR"
    set -a
    . "$API_ENV"
    . "$REFRESH_ENV"
    set +a
    unset REFRESH_ALERT_WEBHOOK_URL
    npm run serve:api
  ) &
  LOCAL_PIDS+=("$!")
}

start_local_refresh() {
  (
    cd "$ROOT_DIR"
    set -a
    . "$REFRESH_ENV"
    set +a
    npm run refresh:official-data
  ) &
  LOCAL_PIDS+=("$!")
}

if [[ "$SKIP_KEYCLOAK" == false ]]; then
  (cd "$ROOT_DIR" && "${COMPOSE[@]}" --env-file "$KEYCLOAK_ENV" -f deploy/keycloak/compose.yaml up -d)
  wait_for_url "http://127.0.0.1:8081/realms/the-club-dev/.well-known/openid-configuration" "Keycloak"
  printf 'Keycloak is ready at http://localhost:8081.\n'
fi

if curl -fsS --max-time 1 http://127.0.0.1:8080/health >/dev/null 2>&1; then
  printf 'Reusing the API already listening on port 8080.\n'
elif user_unit_matches_checkout the-club-api.service; then
  systemctl --user start the-club-api.service
  wait_for_url "http://127.0.0.1:8080/health" "The Club API"
  printf 'Started the API with the user systemd unit.\n'
else
  start_local_api
  wait_for_url "http://127.0.0.1:8080/health" "The Club API"
  printf 'Started the API for this session.\n'
fi

if [[ "$SKIP_REFRESH" == false ]]; then
  if user_unit_matches_checkout the-club-refresh.service; then
    systemctl --user start the-club-refresh.service
    printf 'Started or reused the refresh worker with the user systemd unit.\n'
  elif command -v pgrep >/dev/null && pgrep -f '[s]rc/jobs/official-data-refresh.ts' >/dev/null; then
    printf 'Reusing an existing refresh worker.\n'
  else
    start_local_refresh
    printf 'Started the refresh worker for this session.\n'
  fi
fi

printf 'Starting the web app at http://localhost:5173. Press Ctrl-C to stop this session.\n'
npm run dev:web -- --strictPort