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
import { PostgresClubApiRepository } from "../api/postgres-club-api-repository";
import { buildClubApiServer } from "../api/club-api-server";

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
      "004_oidc_user_subjects.sql",
      "005_contribution_photos.sql",
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
    const apiRepository = new PostgresClubApiRepository({
      query: (text: string, params: any[] = []) => client.query(text, params),
    });
    const linkedOwner = await apiRepository.provisionOidcUser({
      subject: `oidc-${ownerId}`,
      email: `${ownerId}@integration.test`,
      emailVerified: true,
      displayName: "OIDC Integration Owner",
    });
    assert.equal(linkedOwner.id, ownerId);
    assert.equal(linkedOwner.authSubject, `oidc-${ownerId}`);

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
      priceSnapshot: {
        ticketPrice: 2,
        numberRules: {
          mainNumberCount: 5,
          mainNumberMin: 1,
          mainNumberMax: 69,
          bonusNumberMin: 1,
          bonusNumberMax: 26,
        },
        prizeTiers: [],
      },
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

    const options = await apiRepository.getTicketDrawingOptions(ownerId, club.club.id);
    assert.deepEqual(options?.map((option) => [option.drawingDate, option.maxDrawingCount, option.ticketPrice]), [
      ["2026-11-09", 2, 2],
      ["2026-11-11", 1, null],
    ]);
    assert.equal(options?.[0].numberRules?.mainNumberMax, 69);
    assert.equal(await apiRepository.getTicketDrawingOptions(randomUUID(), club.club.id), null);

    const photo = { data: Buffer.from("photo fixture"), contentType: "image/png" };
    const apiContribution = await apiRepository.createContribution(ownerId, club.club.id, {
      lottery: "powerball",
      drawingDate: "2026-11-09",
      drawingCount: 1,
      numbers: [2, 4, 6, 8, 10],
      bonusNumber: 12,
    }, photo);
    assert.equal(apiContribution.costUsd, 2);
    assert.equal(apiContribution.userId, ownerId);
    assert.equal(apiContribution.hasTicketPhoto, true);
    assert.deepEqual(await apiRepository.getContributionPhoto(memberId, club.club.id, apiContribution.id), photo);
    assert.equal(await apiRepository.getContributionPhoto(randomUUID(), club.club.id, apiContribution.id), null);
    assert.equal(await apiRepository.getContributionPhoto(memberId, randomUUID(), apiContribution.id), null);
    await assert.rejects(apiRepository.createContribution(ownerId, club.club.id, {
      lottery: "powerball",
      drawingDate: "2026-11-09",
      drawingCount: 1,
      numbers: [2, 4, 6, 8, 10],
      bonusNumber: 12,
    }, { data: Buffer.alloc(5 * 1024 * 1024 + 1), contentType: "image/png" }));
    const contributionCount = await client.query("SELECT COUNT(*)::int AS count FROM contributions WHERE club_id = $1", [club.club.id]);
    assert.equal(contributionCount.rows[0].count, 2);

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

    const overview = await apiRepository.getClubOverview(ownerId, club.club.id);
    assert.equal(overview?.currentUser.id, ownerId);
    assert.equal(overview?.contributions.length, 2);
    assert.equal(overview?.contributions.find((item) => item.id === apiContribution.id)?.hasTicketPhoto, true);
    assert.equal(overview?.totalContributionsUsd, 6);

    const { rows } = await client.query("SELECT id, share_amount FROM prize_awards WHERE drawing_result_id = $1", [stored.result.id]);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].share_amount), 100);

    const api = await buildClubApiServer({
      repository: apiRepository,
      webOrigin: "https://club.example.test",
      verifyToken: async (token) => ({
        subject: token === "owner" ? `oidc-${ownerId}` : "outsider",
        email: token === "owner" ? `${ownerId}@integration.test` : "outsider@integration.test",
        emailVerified: true,
        displayName: "Integration User",
      }),
    });
    t.after(() => api.close());
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const boundary = "photo-integration";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="contribution"\r\n\r\n${JSON.stringify({ lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 2, numberSets: [{ numbers: [2, 4, 6, 8, 10], bonusNumber: 12 }, { numbers: [1, 3, 5, 7, 9], bonusNumber: 11 }] })}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="ticket.png"\r\nContent-Type: image/png\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const baseUrl = `/api/v1/clubs/${club.club.id}/contributions`;
    const uploaded = await api.inject({ method: "POST", url: baseUrl, headers: { authorization: "Bearer owner", "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(uploaded.statusCode, 201);
    assert.equal(uploaded.json().hasTicketPhoto, true);
    assert.equal(uploaded.json().numberSets.length, 2);
    assert.equal(uploaded.json().costUsd, 8);
    const photoUrl = `${baseUrl}/${uploaded.json().id}/photo`;
    assert.equal((await api.inject({ method: "GET", url: photoUrl })).statusCode, 401);
    assert.equal((await api.inject({ method: "GET", url: photoUrl, headers: { authorization: "Bearer outsider" } })).statusCode, 404);
    const retrieved = await api.inject({ method: "GET", url: photoUrl, headers: { authorization: "Bearer owner" } });
    assert.equal(retrieved.statusCode, 200);
    assert.deepEqual(retrieved.rawPayload, image);
  }
);
