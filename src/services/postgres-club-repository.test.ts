import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";
import type { CalculationSnapshot, DrawingResult, PrizeAward } from "../domain";

import { ClubService } from "./club-service";
import { PostgresClubRepository } from "./postgres-club-repository";

async function setup() {
  const db = newDb();
  const { Client } = db.adapters.createPg();
  const client = new Client();
  await client.connect();

  const schema = `
    CREATE TYPE club_visibility AS ENUM ('public', 'private');
    CREATE TYPE club_status AS ENUM ('active', 'closed');
    CREATE TYPE membership_role AS ENUM ('creator', 'admin', 'member');
    CREATE TYPE membership_status AS ENUM ('pending', 'active', 'removed');
    CREATE TYPE payout_type AS ENUM ('equal_shares', 'proportion_drawing_specific', 'proportion_all_drawings');
    CREATE TYPE threshold_method AS ENUM ('pooled', 'individual');
    CREATE TYPE lottery_type AS ENUM ('powerball', 'mega_millions');
    CREATE TYPE contribution_status AS ENUM ('draft', 'submitted', 'calculated', 'recalculated', 'archived');
    CREATE TYPE drawing_status AS ENUM ('pending', 'results_posted', 'calculated', 'recalculated');
    CREATE TYPE notification_channel AS ENUM ('in_app', 'email', 'push', 'sms');
    CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'failed');
    CREATE TYPE flag_status AS ENUM ('open', 'verified', 'escalated', 'resolved');
    CREATE TYPE prize_award_status AS ENUM ('pending', 'allocated', 'recalculated');

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      phone_number TEXT,
      is_phone_verified BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    );

    CREATE TABLE clubs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      motto TEXT,
      visibility club_visibility NOT NULL,
      owner_user_id TEXT NOT NULL,
      status club_status NOT NULL DEFAULT 'active',
      payout_configuration_id TEXT,
      threshold_rule_id TEXT,
      supported_lotteries lottery_type[] NOT NULL DEFAULT ARRAY[]::lottery_type[],
      allow_search BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    );

    CREATE TABLE club_memberships (
      id TEXT PRIMARY KEY,
      club_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role membership_role NOT NULL,
      status membership_status NOT NULL DEFAULT 'pending',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      removed_at TIMESTAMPTZ,
      removed_by_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (club_id, user_id)
    );

    CREATE TABLE payout_configurations (
      id TEXT PRIMARY KEY,
      club_id TEXT NOT NULL UNIQUE,
      type payout_type NOT NULL,
      version INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE threshold_rules (
      id TEXT PRIMARY KEY,
      club_id TEXT NOT NULL UNIQUE,
      threshold_amount NUMERIC(12,2) NOT NULL CHECK (threshold_amount > 0),
      method threshold_method NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE contributions (
      id TEXT PRIMARY KEY,
      club_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      lottery lottery_type NOT NULL,
      drawing_date DATE NOT NULL,
      drawing_count INT NOT NULL CHECK (drawing_count >= 1),
      number_sets JSONB NOT NULL,
      ticket_image_url TEXT,
      cost_usd NUMERIC(12,2) NOT NULL CHECK (cost_usd > 0),
      status contribution_status NOT NULL DEFAULT 'submitted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version INT NOT NULL DEFAULT 1
    );

    CREATE TABLE drawings (
      id TEXT PRIMARY KEY,
      lottery lottery_type NOT NULL,
      drawing_date DATE NOT NULL,
      state TEXT NOT NULL,
      cutoff_time_et TIME NOT NULL,
      official_result_posted_at TIMESTAMPTZ,
      status drawing_status NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE calculation_snapshots (
      id TEXT PRIMARY KEY,
      drawing_id TEXT NOT NULL,
      club_id TEXT NOT NULL,
      lottery lottery_type NOT NULL,
      rules_url TEXT NOT NULL,
      rules_version TEXT NOT NULL,
      price_snapshot JSONB NOT NULL,
      source_document_url TEXT,
      source_content_type TEXT,
      source_document TEXT,
      source_sha256 TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE drawing_results (
      id TEXT PRIMARY KEY,
      drawing_id TEXT NOT NULL,
      club_id TEXT NOT NULL,
      official_winning_numbers JSONB,
      jackpot_estimate NUMERIC(18,2),
      prize_breakdown JSONB,
      official_source_url TEXT,
      official_source_content_type TEXT,
      official_source_document TEXT,
      official_source_sha256 TEXT,
      status drawing_status NOT NULL DEFAULT 'pending',
      calculation_started_at TIMESTAMPTZ,
      calculated_at TIMESTAMPTZ,
      source_snapshot_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (drawing_id, club_id)
    );

    CREATE UNIQUE INDEX idx_calculation_snapshots_source_hash
      ON calculation_snapshots(drawing_id, club_id, source_sha256)
      WHERE source_sha256 IS NOT NULL;

    CREATE TABLE prize_awards (
      id TEXT PRIMARY KEY,
      drawing_result_id TEXT NOT NULL,
      contribution_id TEXT,
      user_id TEXT,
      club_id TEXT NOT NULL,
      prize_type TEXT NOT NULL,
      gross_prize_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      share_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      threshold_met BOOLEAN NOT NULL DEFAULT false,
      payout_type payout_type,
      status prize_award_status NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      club_id TEXT NOT NULL,
      actor_user_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value JSONB,
      new_value JSONB,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE notification_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      in_app_enabled BOOLEAN NOT NULL DEFAULT true,
      email_enabled BOOLEAN NOT NULL DEFAULT true,
      push_enabled BOOLEAN NOT NULL DEFAULT false,
      sms_enabled BOOLEAN NOT NULL DEFAULT false,
      phone_verified BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      club_id TEXT NOT NULL,
      drawing_id TEXT,
      type TEXT NOT NULL,
      channel notification_channel NOT NULL,
      status notification_status NOT NULL DEFAULT 'queued',
      message TEXT NOT NULL,
      recalculation_type TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE flags (
      id TEXT PRIMARY KEY,
      club_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      prize_award_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status flag_status NOT NULL DEFAULT 'open',
      escalated_to_support BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
  `;

  await client.query(schema);

  const repo = new PostgresClubRepository({
    query: (text: string, params: any[] = []) => client.query(text, params),
  });

  const service = new ClubService(repo);

  return { service, client, db, repo };
}

test("createClub creates a club and creator membership", async () => {
  const { service } = await setup();

  const result = await service.createClub({
    name: "Test Club",
    description: "A test club",
    visibility: "public",
    ownerUserId: "11111111-1111-4111-8111-111111111111",
    supportedLotteries: ["powerball"],
    payoutConfiguration: { type: "equal_shares" },
    thresholdRule: { thresholdAmount: 100, method: "pooled" },
  });

  assert.equal(result.club.name, "Test Club");
  assert.equal(result.membership.role, "creator");
  assert.equal(result.membership.status, "active");
  assert.equal(result.payoutConfiguration.type, "equal_shares");
  assert.equal(result.thresholdRule.thresholdAmount, 100);
});

test("requestMembership and approveMembership work for private clubs", async () => {
  const { service } = await setup();

  const ownerId = "11111111-1111-4111-8111-111111111111";
  const memberId = "22222222-2222-4222-8222-222222222222";

  const club = await service.createClub({
    name: "Private Club",
    visibility: "private",
    ownerUserId: ownerId,
    supportedLotteries: ["powerball"],
    payoutConfiguration: { type: "equal_shares" },
    thresholdRule: { thresholdAmount: 100, method: "individual" },
  });

  const request = await service.requestMembership({ clubId: club.club.id, userId: memberId });
  assert.equal(request.status, "pending");

  const approved = await service.approveMembership({
    clubId: club.club.id,
    userId: memberId,
    actingUserId: ownerId,
  });

  assert.equal(approved.status, "active");
  assert.equal(approved.role, "member");
});

test("leaveClub fails when a member has future contributions", async () => {
  const { service, client } = await setup();

  const ownerId = "11111111-1111-4111-8111-111111111111";
  const memberId = "22222222-2222-4222-8222-222222222222";

  const club = await service.createClub({
    name: "Future Contribution Club",
    visibility: "public",
    ownerUserId: ownerId,
    supportedLotteries: ["mega_millions"],
    payoutConfiguration: { type: "equal_shares" },
    thresholdRule: { thresholdAmount: 50, method: "pooled" },
  });

  await service.requestMembership({ clubId: club.club.id, userId: memberId });

  await client.query(
    `
      INSERT INTO contributions (
        id, club_id, user_id, lottery, drawing_date, drawing_count, number_sets, cost_usd, status, created_at, updated_at, version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), 1)
    `,
    [
      "33333333-3333-4333-8333-333333333333",
      club.club.id,
      memberId,
      "mega_millions",
      "2099-12-31",
      1,
      JSON.stringify([{ numbers: [1, 2, 3, 4, 5], bonus: 6 }]),
      5.0,
      "submitted",
    ]
  );

  await assert.rejects(
    () => service.leaveClub(club.club.id, memberId),
    /cannot leave while they have active contributions/i
  );
});

test("Postgres repository replaces awards and completes a drawing calculation", async () => {
  const { client, repo } = await setup();
  const drawingId = "44444444-4444-4444-8444-444444444444";
  const resultId = "55555555-5555-4555-8555-555555555555";
  const clubId = "66666666-6666-4666-8666-666666666666";
  const now = "2025-01-06T00:00:00.000Z";

  await client.query(
    "INSERT INTO drawings (id, lottery, drawing_date, state, cutoff_time_et, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [drawingId, "powerball", "2025-01-05", "MI", "21:58:00", "results_posted", now]
  );
  await client.query(
    "INSERT INTO drawing_results (id, drawing_id, club_id, official_winning_numbers, status, source_snapshot_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [resultId, drawingId, clubId, JSON.stringify({ numbers: [1, 2, 3, 4, 5] }), "results_posted", "snapshot-1", now]
  );

  assert.equal((await repo.findDrawingById(drawingId))?.drawingDate, "2025-01-05");
  assert.deepEqual((await repo.findDrawingsByLottery("powerball")).map((item) => item.id), [drawingId]);
  assert.deepEqual((await repo.findDrawingResultByDrawingAndClub(drawingId, clubId))?.officialWinningNumbers, {
    numbers: [1, 2, 3, 4, 5],
  });

  const makeAward = (id: string, shareAmount: number, status: PrizeAward["status"]): PrizeAward => ({
    id,
    drawingResultId: resultId,
    contributionId: null,
    userId: "77777777-7777-4777-8777-777777777777",
    clubId,
    prizeType: "drawing_payout",
    grossPrizeAmount: 100,
    shareAmount,
    thresholdMet: true,
    payoutType: "equal_shares",
    status,
    createdAt: now,
    updatedAt: now,
  });

  await repo.replacePrizeAwardsAndCompleteResult(resultId, [makeAward("award-1", 50, "allocated")], "calculated", now);
  const replacement = await repo.replacePrizeAwardsAndCompleteResult(
    resultId,
    [makeAward("award-2", 100, "recalculated")],
    "recalculated",
    now
  );

  assert.equal(replacement.length, 1);
  assert.equal(replacement[0].id, "award-2");
  assert.equal(replacement[0].shareAmount, 100);
  const { rows: savedRows } = await client.query("SELECT id FROM prize_awards WHERE drawing_result_id = $1", [resultId]);
  const { rows: resultRows } = await client.query("SELECT status FROM drawing_results WHERE id = $1", [resultId]);
  const { rows: drawingRows } = await client.query("SELECT status FROM drawings WHERE id = $1", [drawingId]);
  assert.deepEqual(savedRows.map((row: Record<string, any>) => row.id), ["award-2"]);
  assert.equal(resultRows[0].status, "recalculated");
  assert.equal(drawingRows[0].status, "results_posted");
});

test("Postgres repository deduplicates snapshots and invalidates awards when official data changes", async () => {
  const { client, repo } = await setup();
  const drawingId = "88888888-8888-4888-8888-888888888888";
  const clubId = "99999999-9999-4999-8999-999999999999";
  const now = "2026-11-08T03:00:00.000Z";
  await client.query(
    "INSERT INTO drawings (id, lottery, drawing_date, state, cutoff_time_et, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [drawingId, "powerball", "2026-11-07", "MI", "21:58:00", "pending", now]
  );

  const snapshot: CalculationSnapshot = {
    id: "snapshot-1",
    drawingId,
    clubId,
    lottery: "powerball",
    rulesUrl: "https://official.example/rules",
    rulesVersion: "v1",
    priceSnapshot: { ticketPrice: 2, prizeTiers: [] },
    capturedAt: now,
    sourceContentType: "application/json",
    sourceDocument: '{"version":"v1"}',
    sourceSha256: "a".repeat(64),
    sourceDocumentUrl: "https://www.michiganlottery.com/api",
  };
  const result: DrawingResult = {
    id: "result-1",
    drawingId,
    clubId,
    officialWinningNumbers: { numbers: [1, 2, 3, 4, 5], bonusNumber: 6 },
    jackpotEstimate: 100000000,
    prizeBreakdown: { jackpot: 100000000 },
    status: "results_posted",
    sourceSnapshotId: snapshot.id,
    createdAt: now,
    officialSourceUrl: "https://official.example/results",
    officialSourceContentType: "application/json",
    officialSourceDocument: '{"numbers":[1,2,3,4,5]}',
    officialSourceSha256: "b".repeat(64),
  };

  const first = await repo.storeOfficialData(snapshot, result, now);
  assert.equal(first.rulesChanged, true);
  assert.equal(first.resultChanged, true);
  assert.equal(first.result.sourceSnapshotId, first.snapshot.id);

  const award: PrizeAward = {
    id: "award-1",
    drawingResultId: first.result.id,
    contributionId: null,
    userId: "77777777-7777-4777-8777-777777777777",
    clubId,
    prizeType: "jackpot",
    grossPrizeAmount: 100000000,
    shareAmount: 100000000,
    thresholdMet: true,
    payoutType: "equal_shares",
    status: "allocated",
    createdAt: now,
    updatedAt: now,
  };
  await repo.replacePrizeAwardsAndCompleteResult(first.result.id, [award], "calculated", now);

  const repeated = await repo.storeOfficialData({ ...snapshot, id: "snapshot-duplicate" }, { ...result, id: "result-duplicate" }, now);
  assert.equal(repeated.snapshot.id, first.snapshot.id);
  assert.equal(repeated.rulesChanged, false);
  assert.equal(repeated.resultChanged, false);
  assert.equal(repeated.result.status, "calculated");
  const { rows: retainedAwards } = await client.query("SELECT id FROM prize_awards WHERE drawing_result_id = $1", [first.result.id]);
  assert.equal(retainedAwards.length, 1);

  const corrected = await repo.storeOfficialData(
    {
      ...snapshot,
      id: "snapshot-2",
      capturedAt: "2026-11-08T04:00:00.000Z",
      sourceDocument: '{"version":"v1","layout":"updated"}',
      sourceSha256: "c".repeat(64),
    },
    {
      ...result,
      officialWinningNumbers: { numbers: [1, 2, 3, 4, 6], bonusNumber: 7 },
      officialSourceDocument: '{"numbers":[1,2,3,4,6]}',
      officialSourceSha256: "d".repeat(64),
    },
    "2026-11-08T04:00:00.000Z"
  );

  assert.equal(corrected.rulesChanged, false);
  assert.equal(corrected.resultChanged, true);
  assert.equal(corrected.result.status, "results_posted");
  const { rows: clearedAwards } = await client.query("SELECT id FROM prize_awards WHERE drawing_result_id = $1", [first.result.id]);
  assert.equal(clearedAwards.length, 0);
});
