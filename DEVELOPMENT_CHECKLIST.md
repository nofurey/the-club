# Development Checklist

## Completed

- [x] Define the v0.8 club rules and MVP boundaries.
- [x] Add domain types, Zod validators, PostgreSQL schema, and migrations.
- [x] Implement club creation, membership management, in-memory storage, and the Postgres repository.
- [x] Add service and repository tests, including the Postgres integration helper using pg-mem.
- [x] Add an opt-in real-PostgreSQL integration test that applies migrations in a temporary schema.
- [x] Implement payout eligibility and allocations for pooled and individual thresholds, equal shares, and proportional shares.
- [x] Implement drawing calculation, number matching, and snapshot-configured prize tiers for Powerball and Mega Millions.
- [x] Fetch Michigan Lottery rules and results through its public GraphQL endpoint; retain source documents and hashes.
- [x] Fetch Powerball and Mega Millions next-drawing jackpot estimates and cash values; store them on the matching drawing with source metadata.
- [x] Make official-data refreshes idempotent and clear stale awards when normalized rules or results change.
- [x] Verify with `npm run typecheck`, `npm run typecheck:web`, and `npm test` (62 passed; opt-in real-Postgres test skipped without `TEST_DATABASE_URL`).
- [x] Run `npm run test:postgres` against the local PostgreSQL database (1 test passed; migrations, OIDC user linking, API overview/contribution operations, and refresh target discovery ran in a temporary schema).
- [x] Fix PostgreSQL enum parameter inference in the drawing-status update.
- [x] Smoke-test both jackpot/cash endpoints against their live next-drawing dates.
- [x] Apply migrations 001 through 003 to the local PostgreSQL database.
- [x] Add an embeddable scheduled refresh runner with single-flight execution, target spacing, bounded retries, and monitoring events.
- [x] Discover refresh targets from Postgres for active clubs with covered contributions, including unresolved recent and next scheduled drawings.
- [x] Wire the Postgres target source, Michigan provider, refresh service, and runner through a host-startable composition factory.
- [x] Seed local demo club/drawing/contribution data and verify the one-shot worker refreshed Powerball and Mega Millions estimates.
- [x] Add a standalone worker entry point with initial refresh, daily scheduling, structured logs, and graceful shutdown.
- [x] Install and run the local user systemd unit; verify journal collection and successful refresh events.
- [x] Add systemd templates, protected environment examples, and optional failure-webhook alerts.
- [x] Deliver a Discord test alert, move the webhook URL into the mode-600 local environment file, and sanitize tracked examples.
- [x] Build a responsive React frontend with overview, contributions, results, and members views plus a typed demo API and contribution form.
- [x] Add an OIDC Authorization Code + PKCE frontend client and authenticated Fastify API routes for club overview and contribution creation.
- [x] Verify bearer JWT signature, issuer, audience, HTTPS JWKS use, and verified-email claims.
- [x] Resolve missing access-token identity claims through OIDC UserInfo with subject matching and verified-email enforcement.
- [x] Add auth-subject migration 004 and Postgres user linking/API repository support.
- [x] Apply migration 004 to the local PostgreSQL database.
- [x] Prepare a local Keycloak realm, SPA client, and API audience configuration.
- [x] Start Keycloak and verify its local OIDC discovery document.
- [x] Configure local API/frontend OIDC environment and start API plus Vite under the user's local systemd/dev processes.
- [x] Sign in with a verified Keycloak user and receive the authenticated club overview in the browser.
- [x] Verify authenticated overview/contribution persistence against local PostgreSQL.
- [x] Populate ticket entry from member-scoped drawing schedules and saved official pricing and number rules; show unavailable pricing explicitly.
- [x] Parse Markdown-formatted Michigan Lottery ticket prices and refresh corrected rules on uncalculated snapshots.
- [x] Seed upcoming schedules and fetch official rules and prices before a club's first contribution.
- [x] Add authenticated club creation and switch the current browser session to the created club.
- [x] Add active club listing, session switching, and creator/admin-only basic settings edits.
- [x] Add optional ticket photo upload and member-only viewing, backed by migration 005 and PostgreSQL storage.
- [x] Support multiple plays per ticket with per-play pricing and rules-aware number selection.
- [x] Match Michigan Lottery ticket limits: 10 panels, Powerball 1/5-step draws up to 30, and Mega Millions draws up to 26.
- [x] Add locally executed ticket-photo OCR with editable suggestions and required user confirmation.
- [x] Add opt-in, browser-local OCR correction learning and a photo-storage disclaimer.
- [x] Allow members to edit their own submitted tickets before the first drawing cutoff, with atomic audit records.
- [x] Distinguish pending results, pending calculations, calculated results, and recalculations in the results view.
- [x] Replace implicit demo mode with authenticated HTTP by default; keep demo preview explicit for development.
- [x] Build the frontend production bundle and audit production dependencies (0 vulnerabilities).

## Remaining

- [x] Add profile sign-out, atomic Creator transfer, guarded club closure, and authenticated account closure with active-club ownership guards.
- [x] Add identity-provider account registration entry point and provision app users on first verified OIDC sign-in.

- [x] Recalculate and audit tickets changed after a drawing cutoff or posted result.
- [x] Run drawing calculations after official results are refreshed and expose awards and payout allocations.
- [x] Add privacy-safe club discovery, join requests, moderation, role management, leave, and guarded member removal to the authenticated API and frontend.
- [ ] Monitor the site-owned API response formats and confirm permitted use before production reliance; these endpoints are not documented public APIs.
- [ ] Define retention and cleanup for raw source documents and historical calculation artifacts.
- [ ] Add notification delivery and recalculation notices after payout calculations complete.
- [ ] Complete production review of ticket options, jackpot valuation, and payout rules before using calculated amounts operationally.