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
- [x] Verify with `npm run typecheck` and `npm test` (29 passed; opt-in real-Postgres test skipped without `TEST_DATABASE_URL`).
- [x] Run `npm run test:postgres` against the local PostgreSQL database (1 test passed; migrations, persistence, and target discovery ran in a temporary schema).
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

## Remaining

- [ ] Monitor the site-owned API response formats and confirm permitted use before production reliance; these endpoints are not documented public APIs.
- [ ] Define retention and cleanup for raw source documents and historical calculation artifacts.
- [ ] Add notification delivery and recalculation notices after payout calculations complete.
- [ ] Complete production review of ticket options, jackpot valuation, and payout rules before using calculated amounts operationally.