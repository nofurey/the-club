# Development Checklist

## Completed

- [x] Define the v0.8 club rules and MVP boundaries.
- [x] Add domain types, Zod validators, PostgreSQL schema, and migrations.
- [x] Implement club creation, membership management, in-memory storage, and the Postgres repository.
- [x] Add service and repository tests, including the Postgres integration helper using pg-mem.
- [x] Implement payout eligibility and allocations for pooled and individual thresholds, equal shares, and proportional shares.
- [x] Implement drawing calculation, number matching, and snapshot-configured prize tiers for Powerball and Mega Millions.
- [x] Fetch Michigan Lottery rules and results through its public GraphQL endpoint; retain source documents and hashes.
- [x] Fetch Powerball and Mega Millions next-drawing jackpot estimates and cash values; store them on the matching drawing with source metadata.
- [x] Make official-data refreshes idempotent and clear stale awards when normalized rules or results change.
- [x] Verify with `npm run typecheck` and `npm test` (21 tests passing in the last run).
- [x] Smoke-test both jackpot/cash endpoints against their live next-drawing dates.

## Remaining

- [ ] Apply migrations 001 through 003 to a real PostgreSQL instance and run repository integration tests against it.
- [ ] Add a scheduled refresh job with retry policy, rate limiting, and operational monitoring.
- [ ] Monitor the site-owned API response formats and confirm permitted use before production reliance; these endpoints are not documented public APIs.
- [ ] Define retention and cleanup for raw source documents and historical calculation artifacts.
- [ ] Add notification delivery and recalculation notices after payout calculations complete.
- [ ] Complete production review of ticket options, jackpot valuation, and payout rules before using calculated amounts operationally.