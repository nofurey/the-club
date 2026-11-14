# the-club
Lottery Club Application

## Prize Evaluation

`SnapshotLotteryPrizeEvaluator` reads the number format and prize tiers from each calculation snapshot's `priceSnapshot`. Keep these values sourced from the applicable official rules and preserve them with the snapshot so recalculations use the original rules version. The evaluator does not fetch or verify official results itself.

The snapshot must provide `numberRules` (`mainNumberCount`, `mainNumberMin`, `mainNumberMax`, `bonusNumberMin`, `bonusNumberMax`) and a non-empty `prizeTiers` array. Each tier defines `mainMatches`, `bonusMatches`, `prizeType`, and `prizeAmount`. Prize amounts may be fixed numbers, `"jackpot_estimate"` (from the drawing result), or `"prize_breakdown"` (looked up by `prizeType` in the drawing result's prize breakdown).

Multi-draw contributions are matched against the ordered drawing schedule for their lottery; ensure the relevant scheduled draws exist before calculation.

## Official Data Refresh

`MichiganLotteryGraphqlProvider` uses Michigan Lottery's public `https://www.michiganlottery.com/api` GraphQL endpoint for Powerball and Mega Millions. It fetches official game-detail sections and drawing results, parsing number ranges, ticket price, base prize tiers, winning numbers, and any draw-specific payout rows returned by the API. The adapter rejects missing or malformed result fields and out-of-range winning numbers so response-shape changes become refresh failures rather than silently appearing as pending draws. Those failures use the refresh job's bounded retries and monitoring events. `HttpOfficialLotteryProvider` remains available for other configured sources.

The same provider fetches the next-drawing jackpot and cash value from the first-party endpoints used by the Powerball and Mega Millions pages. Estimates are saved on the matching `drawings` row as `estimated_jackpot` and `cash_value`, alongside the source URL, raw response, SHA-256, and capture time. Estimates are only attached when the source's announced drawing date matches the requested drawing; Mega Millions estimates also require its `Verified` flag.

## Ticket Add-ons and Official Result Verification

Each saved play may carry `powerPlay` and `doublePlay` (Powerball, +$1 each per play per drawing) or a required `megaplier` of 2, 3, 4, 5, or 10 (Mega Millions, included in its price). They are stored in the contribution's `number_sets` JSON and validated in the API and repository by `src/services/ticket-options.ts`.

`MuslVerifiedLotteryProvider` wraps the Michigan provider. When a result is posted it also fetches the official Multi-State Lottery pages (`powerball.com/draw-result` for Powerball and Double Play; the `megamillions.com` `GetDrawDataByTickWithMatrix` endpoint for Mega Millions), requires the winning numbers to match Michigan's, and stores the Power Play multiplier, Double Play numbers, draw-specific prize rows, jackpot, cash value, and official jackpot winner count. Prize keys are `match_N_bonus_B` (base), `_power_play`, `_x{multiplier}`, and `double_play_match_N_bonus_B`. All source documents are retained in the result's raw source body.

The evaluator picks the key from each play's options, never reuses a base amount for a multiplier tier, and fails calculation when a winning Mega Millions play has no multiplier, Double Play numbers are missing, or the official jackpot winner count is absent or lower than the club's winning plays.

Michigan Lottery game-detail prices may be wrapped in Markdown formatting; the parser strips that formatting before reading the official ticket price. When parser normalization changes for an unchanged source document, an uncalculated rules snapshot is refreshed in place; snapshots used by completed calculations remain unchanged.

## Data Retention

Raw official-source response bodies are retained for 12 months from capture. Cleanup then nulls the body while preserving its source URL, content type, SHA-256, capture time, and normalized data. Active clubs retain normalized snapshots, results, awards, contributions, ticket photos, and audit history. After a club closes, its history remains available for 12 months, then the club and dependent records are permanently deleted. The cleanup command is a dry run by default; review its JSON counts and ensure a backup succeeded before applying deletion:

```bash
docker compose --env-file ~/.config/the-club/refresh.env --env-file ~/.config/the-club/cloudflare-tunnel.env -f deploy/tunnel/compose.yaml run --rm api ./node_modules/.bin/tsx src/jobs/retention-cleanup.ts
docker compose --env-file ~/.config/the-club/refresh.env --env-file ~/.config/the-club/cloudflare-tunnel.env -f deploy/tunnel/compose.yaml run --rm api ./node_modules/.bin/tsx src/jobs/retention-cleanup.ts --apply
```

Schedule the apply command monthly only after establishing backup and restore procedures. The job deletes prize awards, results, and snapshots in foreign-key-safe order before deleting expired closed clubs.

## Scheduled Official-Data Refresh

`PostgresOfficialDataRefreshTargetSource` selects active clubs with contributions covering unresolved recent drawings or each lottery's next scheduled drawing, using the Eastern calendar date. `OfficialDataRefreshJob` can run once with `runOnce()` or periodically with `start()`/`stop()`. It deduplicates targets, prevents overlapping runs, spaces target starts, retries failures with bounded exponential backoff, and emits structured events through `onEvent` for monitoring. Defaults are a 24-hour interval, a 30-day unresolved-results lookback, three attempts, and one second between target refreshes.

The Compose `refresh-worker` service performs an initial refresh and then runs every 24 hours. Docker restarts it if the process exits; inspect its structured logs with `docker compose --env-file ~/.config/the-club/refresh.env --env-file ~/.config/the-club/cloudflare-tunnel.env -f deploy/tunnel/compose.yaml logs -f refresh-worker`.

For a one-shot refresh without starting the scheduled worker, run `docker compose --env-file ~/.config/the-club/refresh.env --env-file ~/.config/the-club/cloudflare-tunnel.env -f deploy/tunnel/compose.yaml run --rm refresh-worker --once`.

## Container Deployment

Docker Compose is the only supported application runtime. PostgreSQL, API, refresh worker, Caddy, and Cloudflare Tunnel run as containers; Postgres is published only on loopback port `5433`, while API and worker share the host network for localhost database access. No API, worker, database, or Vite development server should be started directly on the host.

Create protected runtime configuration files from the examples and set the Cognito pool/client values and database password:

```bash
mkdir -p ~/.config/the-club
cp deploy/api.env.example ~/.config/the-club/api.env
cp deploy/tunnel/refresh.env.example ~/.config/the-club/refresh.env
cp deploy/tunnel/cloudflare-tunnel.env.example ~/.config/the-club/cloudflare-tunnel.env
cp web/.env.production.example web/.env.production.local
chmod 600 ~/.config/the-club/api.env ~/.config/the-club/refresh.env ~/.config/the-club/cloudflare-tunnel.env
```

Add the public hostname `https://club.ofurey.com/` to the Cognito SPA app client's callback and sign-out URLs. Configure a Cloudflare Tunnel published-application route for `club.ofurey.com` to `http://127.0.0.1:8085`, then place its token only in `~/.config/the-club/cloudflare-tunnel.env`. Start or update the full stack with `npm run tunnel:up`; this command builds the web and API images, then starts all Compose services. The application runtime is Compose-only; use npm commands for build and test tasks, not to start application services.

For a fresh database, start the Compose stack and apply migrations 001 through 008 once:

```bash
npm run tunnel:up
for migration in database/migrations/*.sql; do
	docker exec -i tunnel-postgres-1 psql -U the_club -d the_club -v ON_ERROR_STOP=1 < "$migration"
done
```

For an existing host database, make a private `pg_dump -Fc` backup, start the container database, restore the dump to `127.0.0.1:5433`, compare table counts, then point both protected `DATABASE_URL` values to `postgresql://the_club@127.0.0.1:5433/the_club` before starting the rest of the stack. Keep the host database and backup until the containerized app is verified; do not remove the Compose volume during normal shutdown.

Useful operations:

```bash
docker compose --env-file ~/.config/the-club/refresh.env --env-file ~/.config/the-club/cloudflare-tunnel.env -f deploy/tunnel/compose.yaml ps
docker compose --env-file ~/.config/the-club/refresh.env --env-file ~/.config/the-club/cloudflare-tunnel.env -f deploy/tunnel/compose.yaml logs -f api refresh-worker
docker compose --env-file ~/.config/the-club/refresh.env --env-file ~/.config/the-club/cloudflare-tunnel.env -f deploy/tunnel/compose.yaml run --rm refresh-worker --once
docker compose --env-file ~/.config/the-club/refresh.env --env-file ~/.config/the-club/cloudflare-tunnel.env -f deploy/tunnel/compose.yaml run --rm api ./node_modules/.bin/tsx src/jobs/retention-cleanup.ts
```

`docker compose down` stops the stack but retains the PostgreSQL named volume. Do not use `docker compose down -v` unless you intend to delete the container database.

## Authenticated Club API

The API uses OIDC Authorization Code + PKCE in the browser and verifies bearer access tokens against the configured issuer, audience, and JWKS URL. If the access token omits identity claims, the API calls the configured UserInfo endpoint, requires a `sub` and `email_verified: true`, and matches the UserInfo subject to the token subject whenever the token includes one. `VITE_OIDC_SCOPE` must request an access token whose audience matches `OIDC_AUDIENCE`. Configure the web SPA as a public client with no client secret and register the exact redirect URI. `VITE_CLUB_ID` is optional: it selects an initial club, while users without memberships enter discovery and users with a stale selection fall back to an active membership. Authenticated members can create a club from the sidebar; the new club becomes active for the browser session after its upcoming schedule is seeded and official ticket rules/prices are fetched. The club switcher lists active memberships and changes the active club for the current browser session. Creators and Admins can update basic club details and visibility; payout configuration, threshold, and supported lotteries remain fixed after creation.

For Cognito deployments that require complete profiles, request `openid email profile` and set `OIDC_REQUIRE_COGNITO_PROFILE=true`. The API stores Cognito `preferred_username`, `given_name`, and `family_name`; usernames must be unique regardless of case. Public club member views display usernames and do not expose member email addresses. Private club views display first and last names.

Authenticated users can search `GET /api/v1/clubs/discovery?q=...` and join or request access with `POST /api/v1/clubs/:clubId/membership`. Public clubs activate membership immediately; private clubs create a pending request. Searchable private results expose only the club ID, name, visibility, and the caller's own membership status. Active Creators/Admins can list requests and approve or reject them. Members can leave unless they have active future-draw contributions; only the Creator can grant or remove Admin status and forcibly remove members. Forced removal is blocked after a drawing cutoff until that club's payout calculation completes, and while the target member has a pending payout. All actor IDs come from the verified bearer identity, not request payloads.

Creators can transfer ownership with `POST /api/v1/clubs/:clubId/transfer-ownership` to an active Admin; the club owner and both membership roles update in one database transaction. A Creator can close an eligible club with `POST /api/v1/clubs/:clubId/close`; closure is blocked while future contributions or incomplete payouts remain. Users can sign out from the profile panel or close their account with `POST /api/v1/me/close`. Account closure is blocked while the user owns an active club; transfer ownership or close the club first. Closure marks the user inactive, keeps club and ticket records for the remaining members, and prevents future authenticated API access.

## Notifications

Notifications are recorded in the same transaction that completes or recalculates a drawing payout. Initial payout notices follow the configured threshold and payout strategy; recalculations notify members whose recorded payout was added, removed, or changed. The bell opens the in-app inbox, where each member can mark notices read and toggle in-app/email preferences. Email notices are queued and drained by the API once a minute, with a five-minute claim lease and up to five attempts; SMTP delivery is at-least-once, so a process crash after SMTP accepts a message but before the database records success may cause a duplicate. Without SMTP configuration, in-app notices still work and email stays queued.

Set `NOTIFICATION_SMTP_HOST`, `NOTIFICATION_SMTP_FROM`, and optionally `NOTIFICATION_SMTP_PORT` (default `587`), `NOTIFICATION_SMTP_SECURE` (`true` for implicit TLS, otherwise STARTTLS), `NOTIFICATION_SMTP_USER`, and `NOTIFICATION_SMTP_PASSWORD` in the protected API environment. Cognito email settings do not automatically configure API notifications; configure SMTP separately in the protected container environment if email notices are wanted. Push and SMS are not implemented and remain disabled.

Ticket entry loads scheduled drawings and saved club-specific official rules and pricing from the authenticated `GET /api/v1/clubs/:clubId/ticket-drawings` endpoint. On first request, the API idempotently seeds up to 30 Powerball and 26 Mega Millions drawing dates and fetches missing official rules/prices once per lottery; the resulting price snapshot applies across that game's schedule. Current Michigan Lottery pages allow 10 panels per ticket, Powerball draw counts of 1 or multiples of 5 through 30, and Mega Millions draw counts from 1 through 26: [Powerball](https://www.michiganlottery.com/games/powerball) and [Mega Millions](https://www.michiganlottery.com/games/mega-millions). If an official source is temporarily unavailable, pricing remains unavailable and can be retried from the form. Drawing dates and ticket cutoffs follow the Michigan weekday schedule. The scheduled refresh calculates drawings after official numbers are posted and recalculates completed awards when official inputs change. The results view distinguishes posted numbers from completed calculations and shows member gross prizes and allocated payout shares.

Contributions can include one optional JPEG, PNG, or WebP ticket photo up to 5 MiB. Photos are stored in PostgreSQL with their contribution and returned only to active club members through the authenticated photo endpoint. They are included in database backups and are deleted when their contribution is deleted.

Members can edit their own submitted tickets before or after the covered drawings' sales cutoffs. Each edit revalidates the saved official rules and price, increments the contribution version, preserves its photo, and atomically records old and new values in `audit_events`. If an affected drawing has posted official numbers, its old awards are cleared atomically and the drawing is recalculated before the API responds. If recalculation fails, the edit remains saved and the result stays pending calculation rather than showing stale awards. Edits are rejected for tickets whose contribution status is no longer `submitted` or whose posted result lacks a calculation snapshot.

Michigan Lottery ticket entry allows up to 10 panels per ticket. Powerball supports 1 or 5-step selections up to 30 drawings; Mega Millions supports 1 through 26 drawings. The UI derives available choices from the seeded schedule, and the API enforces the same game-specific limits. Each panel is priced using the saved official price per drawing. The ticket reader uses Tesseract OCR in the browser with locally served worker and English-language assets. It suggests complete number sets only; it does not determine the lottery, drawing dates, paid options, or actual ticket price. OCR can miss or misread plays, so members must compare every suggestion and add missing plays before confirming. Photos are not sent to an external OCR service.

Members may opt in per ticket to remember manually confirmed plays on their current browser, even when OCR cannot read the photo. The per-user local model stores up to 50 sets of plays with SHA-256 photo fingerprints, plus OCR token-correction counts; it does not store images or full OCR text for learning. Remembered plays are suggested only for the exact same photo and lottery, and still require review. When recognizable OCR rows are available, a correction is used only after at least three different photos support it with at least 90% agreement. The ticket owner can also opt in from an already-saved ticket's photo view. The contribution form can clear this local learning data without deleting saved ticket photos. The model does not retrain Tesseract, sync between browsers, or learn visual recognition from unreadable rows; existing tickets are not used automatically.

Apply database migrations 001 through 008 to the container database before first use. The API, refresh worker, PostgreSQL, and web application are run through the Compose stack described above; do not start their server processes directly on the host. Cognito is the supported OIDC provider. Configure its issuer, app-client ID, managed-login domain, read access to email attributes, and exact callback/sign-out URLs in the protected API environment and public web build environment. SPA clients must not have a client secret. The API requires a verified email and validates Cognito access-token signature, issuer, token type, client ID, and the matching signed identity token when needed.

### Cloudflare Tunnel for the home-hosted app

The home app can be published through Cloudflare Tunnel without router port forwarding. This uses a host-networked Caddy container to serve the production bundle and proxy `/api` to the loopback-only API; the `cloudflared` container makes the outbound Tunnel connection. Nothing listens publicly on the home network.

Before starting the Tunnel, add `https://club.ofurey.com/` to the Cognito app client's allowed callback and sign-out URLs. Copy `web/.env.production.example` to `web/.env.production.local`. The API `WEB_ORIGIN` setting accepts a comma-separated list; include both `http://localhost:5173` and `https://club.ofurey.com` if local and public browsers should both work.

In Cloudflare Zero Trust, create a named Tunnel and a public hostname `club.ofurey.com` with service type HTTP and URL `http://127.0.0.1:8085`. Cloudflare creates the DNS record. Copy only the Tunnel token into a private file; never paste it into chat or commit it:

```bash
mkdir -p ~/.config/the-club
cp deploy/tunnel/cloudflare-tunnel.env.example ~/.config/the-club/cloudflare-tunnel.env
chmod 600 ~/.config/the-club/cloudflare-tunnel.env
nano ~/.config/the-club/cloudflare-tunnel.env
npm run tunnel:up
```

The launcher builds the production web app and starts PostgreSQL, the API, refresh worker, Caddy, and `cloudflared` with Docker Compose. PostgreSQL uses a persistent named volume and publishes its port only on `127.0.0.1:5433`; the API and worker use host networking to reach it. The API still binds to `127.0.0.1:8080` and is not published directly. Docker restart policies manage every application service.

For an existing host database, back it up before migration. Start the new database container, restore the custom-format dump to port 5433, compare key table counts, then change `DATABASE_URL` in both protected API and refresh environment files to `postgresql://the_club@127.0.0.1:5433/the_club` before starting the API and worker containers. Keep the original host database intact until the containerized app is verified; it can remain stopped or serve as a rollback copy. A fresh container creates an empty database and still needs migrations 001 through 008 applied before app use. Confirm Cognito login and API behavior at `https://club.ofurey.com` before removing older DNS records or the existing Route 53 hosted zone. The `www.ofurey.com` CloudFront record is separate and should be retained if that hostname is still needed.

## PostgreSQL Integration Test

Set `TEST_DATABASE_URL` to a dedicated local test database and run `npm run test:postgres`. The test creates a uniquely named temporary schema, applies migrations 001 through 008 there, exercises the Postgres repository, notification delivery, and retention cleanup, and drops only that schema. It does not modify the database's public schema. Set `PGPASSWORD` in the shell rather than embedding credentials in the URL.
