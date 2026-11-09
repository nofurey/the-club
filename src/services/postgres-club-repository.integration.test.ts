import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";

import type { CalculationSnapshot, DrawingResult, DrawingSizeSnapshot, PrizeAward } from "../domain";
import { ClubService } from "./club-service";
import { PostgresClubRepository } from "./postgres-club-repository";
import { PostgresOfficialDataRefreshTargetSource } from "./postgres-official-data-refresh-target-source";

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = test;

postgresTest(
  "real PostgreSQL applies migrations and persists club, estimates, results, and awards",
  { skip: !databaseUrl && "Set TEST_DATABASE_URL to run real PostgreSQL integration tests." },
  async (t) => {
    if (!databaseUrl) {
      return;
    }

    const client = new Client({ connectionString: databaseUrl });
    const schema = `club_integration_${randomUUID().replace(/-/g, "")}`;
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    t.after(async () => {
      try {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await client.end();
      }
    });
    await client.query(`SET search_path TO "${schema}"`);

    for (const migrationName of [
      "001_init_schema.sql",
      "002_official_data_sources.sql",
      "003_drawing_jackpot_estimates.sql",
    ]) {
      const migrationPath = path.resolve(__dirname, "../../database/migrations", migrationName);
      await client.query(fs.readFileSync(migrationPath, "utf8"));
    }

    const ownerId = randomUUID();
    const memberId = randomUUID();
    await client.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3), ($4, $5, $6)",
      [ownerId, `${ownerId}@integration.test`, "Integration Owner", memberId, `${memberId}@integration.test`, "Integration Member"]
    );

    const repository = new PostgresClubRepository({
      query: (text: string, params: any[] = []) => client.query(text, params),
    });
    const service = new ClubService(repository);
    const club = await service.createClub({
      name: "Postgres Integration Club",
      visibility: "public",
      ownerUserId: ownerId,
      supportedLotteries: ["powerball"],
      payoutConfiguration: { type: "equal_shares" },
      thresholdRule: { thresholdAmount: 100, method: "pooled" },
    });
    assert.deepEqual(club.club.supportedLotteries, ["powerball"]);
    const membership = await service.requestMembership({ clubId: club.club.id, userId: memberId });
    assert.equal(membership.status, "active");

    const drawingId = randomUUID();
    const nextDrawingId = randomUUID();
    const resultId = randomUUID();
    const now = new Date().toISOString();
    await client.query(
      "INSERT INTO drawings (id, lottery, drawing_date, state, cutoff_time_et, status) VALUES ($1, $2, $3, $4, $5, $6)",
      [drawingId, "powerball", "2026-11-09", "MI", "21:58:00", "pending"]
    );
    await client.query(
      "INSERT INTO drawings (id, lottery, drawing_date, state, cutoff_time_et, status) VALUES ($1, $2, $3, $4, $5, $6)",
      [nextDrawingId, "powerball", "2026-11-11", "MI", "21:58:00", "pending"]
    );
    await client.query(
      `
        INSERT INTO contributions (
          id, club_id, user_id, lottery, drawing_date, drawing_count, number_sets, cost_usd, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [randomUUID(), club.club.id, ownerId, "powerball", "2026-11-09", 2, JSON.stringify([{ numbers: [1, 2, 3, 4, 5], bonusNumber: 6 }]), 4, "submitted"]
    );

    const { rows: targetFixtureRows } = await client.query(
      `
         SELECT c.status AS club_status, c.supported_lotteries::text[] AS supported_lotteries,
           d.lottery, contribution.status AS contribution_status
        FROM clubs c
        JOIN drawings d ON d.id = $2
        JOIN contributions contribution ON contribution.club_id = c.id AND contribution.lottery = d.lottery
        WHERE c.id = $1
      `,
      [club.club.id, drawingId]
    );
    assert.equal(targetFixtureRows.length, 1);
    assert.equal(targetFixtureRows[0].club_status, "active");
    assert.deepEqual(targetFixtureRows[0].supported_lotteries, ["powerball"]);
    assert.equal(targetFixtureRows[0].lottery, "powerball");
    assert.equal(targetFixtureRows[0].contribution_status, "submitted");

    const targetSource = new PostgresOfficialDataRefreshTargetSource(
      repository,
      30,
      () => new Date("2026-11-10T12:00:00.000Z")
    );
    assert.deepEqual(await targetSource.getTargets(), [
      { drawingId, clubId: club.club.id },
      { drawingId: nextDrawingId, clubId: club.club.id },
    ]);

    const snapshot: CalculationSnapshot = {
      id: randomUUID(),
      drawingId,
      clubId: club.club.id,
      lottery: "powerball",
      rulesUrl: "https://www.michiganlottery.com/games/powerball",
      rulesVersion: "integration-v1",
      priceSnapshot: { ticketPrice: 2, numberRules: { mainNumberCount: 5 }, prizeTiers: [] },
      capturedAt: now,
      sourceDocumentUrl: "https://www.michiganlottery.com/api",
      sourceContentType: "application/json",
      sourceDocument: '{"rules":"fixture"}',
      sourceSha256: "a".repeat(64),
    };
    const result: DrawingResult = {
      id: resultId,
      drawingId,
      clubId: club.club.id,
      officialWinningNumbers: { numbers: [1, 2, 3, 4, 5], bonusNumber: 6 },
      jackpotEstimate: 1000000,
      prizeBreakdown: { jackpot: 1000000 },
      status: "results_posted",
      sourceSnapshotId: snapshot.id,
      createdAt: now,
      officialSourceUrl: "https://www.michiganlottery.com/api",
      officialSourceContentType: "application/json",
      officialSourceDocument: '{"result":"fixture"}',
      officialSourceSha256: "b".repeat(64),
    };
    const drawingSize: DrawingSizeSnapshot = {
      drawingDate: "2026-11-09",
      estimatedJackpot: 30000000,
      cashValue: 12900000,
      sourceUrl: "https://www.powerball.com/v1/gameapi/next-drawing?gamecode=powerball&language=en",
      sourceContentType: "text/html",
      sourceDocument: "<div>Estimated Jackpot $30 Million; Cash Value $12.9 Million</div>",
      sourceSha256: "c".repeat(64),
      capturedAt: now,
    };

    const stored = await repository.storeOfficialData(snapshot, result, now, drawingSize);
    assert.equal(stored.drawingSizeUpdated, true);
    assert.equal((await repository.findDrawingById(drawingId))?.estimatedJackpot, 30000000);
    assert.equal((await repository.findDrawingById(drawingId))?.cashValue, 12900000);
    assert.equal((await repository.findCalculationSnapshotById(snapshot.id))?.sourceSha256, snapshot.sourceSha256);

    const award: PrizeAward = {
      id: randomUUID(),
      drawingResultId: stored.result.id,
      contributionId: null,
      userId: ownerId,
      clubId: club.club.id,
      prizeType: "drawing_payout",
      grossPrizeAmount: 100,
      shareAmount: 100,
      thresholdMet: true,
      payoutType: "equal_shares",
      status: "allocated",
      createdAt: now,
      updatedAt: now,
    };
    await repository.replacePrizeAwardsAndCompleteResult(stored.result.id, [award], "calculated", now);
    const persistedResult = await repository.findDrawingResultByDrawingAndClub(drawingId, club.club.id);
    assert.equal(persistedResult?.status, "calculated");

    const { rows } = await client.query("SELECT id, share_amount FROM prize_awards WHERE drawing_result_id = $1", [stored.result.id]);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].share_amount), 100);
  }
);
