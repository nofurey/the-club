# the-club
Lottery Club Application

## Prize Evaluation

`SnapshotLotteryPrizeEvaluator` reads the number format and prize tiers from each calculation snapshot's `priceSnapshot`. Keep these values sourced from the applicable official rules and preserve them with the snapshot so recalculations use the original rules version. The evaluator does not fetch or verify official results itself.

The snapshot must provide `numberRules` (`mainNumberCount`, `mainNumberMin`, `mainNumberMax`, `bonusNumberMin`, `bonusNumberMax`) and a non-empty `prizeTiers` array. Each tier defines `mainMatches`, `bonusMatches`, `prizeType`, and `prizeAmount`. Prize amounts may be fixed numbers, `"jackpot_estimate"` (from the drawing result), or `"prize_breakdown"` (looked up by `prizeType` in the drawing result's prize breakdown).

Multi-draw contributions are matched against the ordered drawing schedule for their lottery; ensure the relevant scheduled draws exist before calculation.

## Official Data Refresh

`MichiganLotteryGraphqlProvider` uses Michigan Lottery's public `https://www.michiganlottery.com/api` GraphQL endpoint for Powerball and Mega Millions. It fetches official game-detail sections and drawing results, parsing number ranges, ticket price, base prize tiers, winning numbers, and any draw-specific payout rows returned by the API. `HttpOfficialLotteryProvider` remains available for other configured sources.

The same provider fetches the next-drawing jackpot and cash value from the first-party endpoints used by the Powerball and Mega Millions pages. Estimates are saved on the matching `drawings` row as `estimated_jackpot` and `cash_value`, alongside the source URL, raw response, SHA-256, and capture time. Estimates are only attached when the source's announced drawing date matches the requested drawing; Mega Millions estimates also require its `Verified` flag.

Michigan Lottery game-detail prices may be wrapped in Markdown formatting; the parser strips that formatting before reading the official ticket price. When parser normalization changes for an unchanged source document, an uncalculated rules snapshot is refreshed in place; snapshots used by completed calculations remain unchanged.

## Scheduled Official-Data Refresh

`PostgresOfficialDataRefreshTargetSource` selects active clubs with contributions covering unresolved recent drawings or each lottery's next scheduled drawing, using the Eastern calendar date. `OfficialDataRefreshJob` can run once with `runOnce()` or periodically with `start()`/`stop()`. It deduplicates targets, prevents overlapping runs, spaces target starts, retries failures with bounded exponential backoff, and emits structured events through `onEvent` for monitoring. Defaults are a 24-hour interval, a 30-day unresolved-results lookback, three attempts, and one second between target refreshes.

Run the standalone worker with `DATABASE_URL` set using `npm run refresh:official-data`. It performs an initial refresh, then runs every 24 hours, and handles `SIGINT`/`SIGTERM` for graceful shutdown. Run it under a process manager in production; it emits structured JSON logs, but external log aggregation and alerting still need to be configured.

For a local smoke test, `database/dev-seed-official-refresh.sql` idempotently creates a demo club, members, upcoming drawings, and multi-draw contributions for both supported lotteries. With `PGPASSWORD` and `DATABASE_URL` set in the shell, run:

```bash
psql -h 127.0.0.1 -U the_club -d the_club -W -v ON_ERROR_STOP=1 -f database/dev-seed-official-refresh.sql
npm run refresh:official-data:once
```

The one-shot command runs a single refresh without starting another daily worker.

## Linux Deployment

### Local user service

For a local machine with systemd enabled for your user, install the rootless unit:

Edit the copied environment file to set `PGPASSWORD` before enabling or starting the service. Set `REFRESH_ALERT_WEBHOOK_URL` only when you have a monitoring endpoint; keep the file private and never commit it.

```bash
mkdir -p ~/.config/systemd/user ~/.config/the-club
cp deploy/systemd/user/the-club-refresh.service ~/.config/systemd/user/
cp deploy/systemd/user/refresh.env.example ~/.config/the-club/refresh.env
chmod 600 ~/.config/the-club/refresh.env
nano ~/.config/the-club/refresh.env
systemctl --user daemon-reload
systemctl --user enable --now the-club-refresh.service
systemctl --user status the-club-refresh.service
journalctl --user -u the-club-refresh.service -f
```

The unit starts immediately and then refreshes daily. If the user manager does not persist after logout, an administrator must enable lingering for the account. On the current local machine, the unit is already linked and enabled but left inactive until its environment file is configured; start it with `systemctl --user start the-club-refresh.service` after replacing the password placeholder.

### System service

`deploy/systemd/the-club-refresh.service` is a systemd template for a dedicated `the-club` service user and an install at `/opt/the-club/current`; adjust those values for the target host. It restarts on process failure and sends the worker's structured stdout/stderr to journald. The worker handles `SIGTERM` for graceful shutdown.

Copy `deploy/systemd/refresh.env.example` to `/etc/the-club/refresh.env`, set `DATABASE_URL`, `PGPASSWORD`, and optionally `REFRESH_ALERT_WEBHOOK_URL`, and restrict the file to root (`chmod 600`). Install and start the unit:

```bash
sudo install -d -m 0700 /etc/the-club
sudo cp deploy/systemd/refresh.env.example /etc/the-club/refresh.env
sudo chmod 600 /etc/the-club/refresh.env
sudoedit /etc/the-club/refresh.env
sudo install -m 0644 deploy/systemd/the-club-refresh.service /etc/systemd/system/the-club-refresh.service
sudo systemctl daemon-reload
sudo systemctl enable --now the-club-refresh
journalctl -u the-club-refresh -f
```

When configured, Discord webhooks receive a Discord-formatted message for failed runs or targets only. Other HTTP(S) webhooks receive JSON `{ "type": "official_data_refresh_failure", "event": ... }`. Delivery errors are logged to journald and are not retried.

Install and run the oneshot alert-test unit to verify the configured endpoint without touching the database:

```bash
cp deploy/systemd/user/the-club-refresh-alert-test.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start the-club-refresh-alert-test.service
journalctl --user -u the-club-refresh-alert-test.service -n 20
```

Successful delivery logs `alert_test_delivered`; an HTTP or network failure causes the oneshot unit to fail and logs `alert_delivery_failed`.

Wire `new OfficialLotteryDataService(repository, new MichiganLotteryGraphqlProvider())` and call `refreshDrawing({ drawingId, clubId })` to fetch, validate, and store the normalized data and raw GraphQL responses. The canonical game page and exact API document URL, retrieval metadata, and SHA-256 hashes are retained. Repeated identical fetches are deduplicated; changed normalized rules or results clear stale awards and reopen the result for calculation.

Apply `database/migrations/002_official_data_sources.sql`, `database/migrations/003_drawing_jackpot_estimates.sql`, and `database/migrations/004_oidc_user_subjects.sql` after the initial schema migration. The provider does not substitute the current estimated jackpot for a historical draw's jackpot. If the API omits draw-specific payout rows or jackpot estimates, those values remain absent; prize calculation must wait for an official value rather than infer one from a generic prize table.

## Authenticated Club API

The API uses OIDC Authorization Code + PKCE in the browser and verifies bearer access tokens against the configured issuer, audience, and JWKS URL. If the access token omits identity claims, the API calls the configured UserInfo endpoint, requires a `sub` and `email_verified: true`, and matches the UserInfo subject to the token subject whenever the token includes one. `VITE_OIDC_SCOPE` must request an access token whose audience matches `OIDC_AUDIENCE`. Configure the web SPA as a public client with no client secret and register the exact redirect URI. `VITE_CLUB_ID` is optional: it selects an initial club, while users without memberships enter discovery and users with a stale selection fall back to an active membership. Authenticated members can create a club from the sidebar; the new club becomes active for the browser session after its upcoming schedule is seeded and official ticket rules/prices are fetched. The club switcher lists active memberships and changes the active club for the current browser session. Creators and Admins can update basic club details and visibility; payout configuration, threshold, and supported lotteries remain fixed after creation.

Authenticated users can search `GET /api/v1/clubs/discovery?q=...` and join or request access with `POST /api/v1/clubs/:clubId/membership`. Public clubs activate membership immediately; private clubs create a pending request. Searchable private results expose only the club ID, name, visibility, and the caller's own membership status. Active Creators/Admins can list requests and approve or reject them. Members can leave unless they have active future-draw contributions; only the Creator can grant or remove Admin status and forcibly remove members. Forced removal is blocked after a drawing cutoff until that club's payout calculation completes, and while the target member has a pending payout. All actor IDs come from the verified bearer identity, not request payloads.

Creators can transfer ownership with `POST /api/v1/clubs/:clubId/transfer-ownership` to an active Admin; the club owner and both membership roles update in one database transaction. A Creator can close an eligible club with `POST /api/v1/clubs/:clubId/close`; closure is blocked while future contributions or incomplete payouts remain. Users can sign out from the profile panel or close their account with `POST /api/v1/me/close`. Account closure is blocked while the user owns an active club; transfer ownership or close the club first. Closure marks the user inactive, keeps club and ticket records for the remaining members, and prevents future authenticated API access.

Ticket entry loads scheduled drawings and saved club-specific official rules and pricing from the authenticated `GET /api/v1/clubs/:clubId/ticket-drawings` endpoint. On first request, the API idempotently seeds up to 30 Powerball and 26 Mega Millions drawing dates and fetches missing official rules/prices once per lottery; the resulting price snapshot applies across that game's schedule. Current Michigan Lottery pages allow 10 panels per ticket, Powerball draw counts of 1 or multiples of 5 through 30, and Mega Millions draw counts from 1 through 26: [Powerball](https://www.michiganlottery.com/games/powerball) and [Mega Millions](https://www.michiganlottery.com/games/mega-millions). If an official source is temporarily unavailable, pricing remains unavailable and can be retried from the form. Drawing dates and ticket cutoffs follow the Michigan weekday schedule. The scheduled refresh calculates drawings after official numbers are posted and recalculates completed awards when official inputs change. The results view distinguishes posted numbers from completed calculations and shows member gross prizes and allocated payout shares.

Contributions can include one optional JPEG, PNG, or WebP ticket photo up to 5 MiB. Photos are stored in PostgreSQL with their contribution and returned only to active club members through the authenticated photo endpoint. They are included in database backups and are deleted when their contribution is deleted.

Members can edit their own submitted tickets before or after the covered drawings' sales cutoffs. Each edit revalidates the saved official rules and price, increments the contribution version, preserves its photo, and atomically records old and new values in `audit_events`. If an affected drawing has posted official numbers, its old awards are cleared atomically and the drawing is recalculated before the API responds. If recalculation fails, the edit remains saved and the result stays pending calculation rather than showing stale awards. Edits are rejected for tickets whose contribution status is no longer `submitted` or whose posted result lacks a calculation snapshot.

Michigan Lottery ticket entry allows up to 10 panels per ticket. Powerball supports 1 or 5-step selections up to 30 drawings; Mega Millions supports 1 through 26 drawings. The UI derives available choices from the seeded schedule, and the API enforces the same game-specific limits. Each panel is priced using the saved official price per drawing. The ticket reader uses Tesseract OCR in the browser with locally served worker and English-language assets. It suggests complete number sets only; it does not determine the lottery, drawing dates, paid options, or actual ticket price. OCR can miss or misread plays, so members must compare every suggestion and add missing plays before confirming. Photos are not sent to an external OCR service.

Members may opt in per ticket to remember manually confirmed plays on their current browser, even when OCR cannot read the photo. The per-user local model stores up to 50 sets of plays with SHA-256 photo fingerprints, plus OCR token-correction counts; it does not store images or full OCR text for learning. Remembered plays are suggested only for the exact same photo and lottery, and still require review. When recognizable OCR rows are available, a correction is used only after at least three different photos support it with at least 90% agreement. The ticket owner can also opt in from an already-saved ticket's photo view. The contribution form can clear this local learning data without deleting saved ticket photos. The model does not retrain Tesseract, sync between browsers, or learn visual recognition from unreadable rows; existing tickets are not used automatically.

Apply `database/migrations/004_oidc_user_subjects.sql` and `database/migrations/005_contribution_photos.sql` after migrations 001 through 003. Configure the API from `deploy/api.env.example`, set `DATABASE_URL`, `PGPASSWORD`, OIDC settings, `WEB_ORIGIN`, and `API_PORT`, then run `npm run serve:api`. The API binds only to `127.0.0.1`; production traffic must reach it through an HTTPS reverse proxy. In local development, Vite proxies `/api` to `http://127.0.0.1:8080`.

Copy `deploy/api.env.example` to `~/.config/the-club/api.env` and `web/.env.example` to `web/.env.local`. Set the OIDC issuer, audience, JWKS URL, SPA client ID, and registered redirect URI. Set `VITE_CLUB_ID` only when a specific initial club should be selected. Never put a client secret in the browser config. Demo data is available only when `VITE_USE_DEMO_API=true`; otherwise an unconfigured identity provider produces a setup screen rather than falling back to fake data.

For local user-systemd API startup, copy `deploy/systemd/user/the-club-api.service` to `~/.config/systemd/user/`, protect the API environment file with `chmod 600`, then run `systemctl --user daemon-reload` and `systemctl --user enable --now the-club-api.service`. The local unit also loads `~/.config/the-club/refresh.env` after `api.env` so the existing local PostgreSQL credentials override template placeholders; do not use that shared-secret arrangement for production. The unit is included in this repository but isn’t installed or started automatically.

For production HTTPS, adapt `deploy/caddy/Caddyfile.example` to your hostname and installation path. Caddy terminates TLS and proxies `/api` to the loopback-only API. Configure the OIDC provider’s allowed callback URI and `WEB_ORIGIN` to the same HTTPS site origin.

### Local Keycloak

The repository includes a development-only Keycloak realm/client import. It registers `the-club-web` as a public PKCE client and maps the `the-club-api` audience. Keycloak is bound to `127.0.0.1:8081`; `start-dev` is for local development only and must not be used as the production identity service.

Install Docker Engine and the Compose plugin, then start Keycloak:

```bash
cd deploy/keycloak
cp .env.example .env
chmod 600 .env
nano .env
docker compose --env-file .env up -d
```

The local realm enables self-registration. From the app, choose **Create an account** to open Keycloak's login page, then use its registration link. If the realm was imported before registration was enabled, turn on **User registration** under **Realm Settings → Login** in the Keycloak admin console; realm imports do not overwrite an existing realm. The local realm has no SMTP server, so mark the new user's email as verified in the Keycloak admin console before signing in to the app. On the first verified OIDC sign-in, the API creates the corresponding app user. Production identity providers must verify email as part of their registration flow; the API rejects unverified identities. To use the seeded demo club, use `refresh-demo-owner@example.invalid` as the Keycloak user's email and mark it verified.

For the API, copy `deploy/api.env.example` to `~/.config/the-club/api.env`, keep it mode `600`, and set the local Postgres password. Apply any outstanding migrations through 005 once from the repository root. Start the API in one terminal:

```bash
set -a
. ~/.config/the-club/api.env
set +a
npm run serve:api
```

Copy `web/.env.example` to `web/.env.local`, then start Vite in another terminal with `npm run dev:web`. The web example is prefilled for the local realm and callback URI. Docker/Podman are not included with this repository; a container runtime is required to start Keycloak.

## PostgreSQL Integration Test

Set `TEST_DATABASE_URL` to a dedicated local test database and run `npm run test:postgres`. The test creates a uniquely named temporary schema, applies migrations 001 through 005 there, exercises the Postgres repository, and drops only that schema. It does not modify the database's public schema. Set `PGPASSWORD` in the shell rather than embedding credentials in the URL.
