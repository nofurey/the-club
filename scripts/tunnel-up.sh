#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/the-club"
TUNNEL_ENV="$CONFIG_DIR/cloudflare-tunnel.env"
API_ENV="$CONFIG_DIR/api.env"
REFRESH_ENV="$CONFIG_DIR/refresh.env"
PRODUCTION_WEB_ENV="$ROOT_DIR/web/.env.production.local"

die() {
  printf 'tunnel-up: %s\n' "$1" >&2
  exit 1
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf 'Usage: %s\n' "${0##*/}"
  printf 'Build and start the container-only application stack from protected local env files.\n'
  exit 0
fi

if (($#)); then
  die "Unknown option: $1"
fi

[[ -f "$TUNNEL_ENV" ]] || die "Create $TUNNEL_ENV from deploy/tunnel/cloudflare-tunnel.env.example and paste the tunnel token there."
[[ -f "$API_ENV" ]] || die "Missing $API_ENV."
[[ -f "$REFRESH_ENV" ]] || die "Missing $REFRESH_ENV."
[[ -f "$PRODUCTION_WEB_ENV" ]] || die "Create web/.env.production.local from web/.env.production.example and add it to Cognito callback/sign-out URLs."
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || die "Docker Compose is required."

chmod 600 "$TUNNEL_ENV"
if grep -q 'replace-with-the-token' "$TUNNEL_ENV"; then
  die "Replace the tunnel token placeholder in $TUNNEL_ENV."
fi

COMPOSE=(docker compose --env-file "$REFRESH_ENV" --env-file "$TUNNEL_ENV" -f deploy/tunnel/compose.yaml)
"${COMPOSE[@]}" up -d --build --wait
"${COMPOSE[@]}" ps
printf 'PostgreSQL, API, refresh worker, web app, and Cloudflare Tunnel are running in Docker.\n'
printf 'Public app: https://club.ofurey.com\n'