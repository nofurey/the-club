import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";

import type { CalculationSnapshot, DrawingResult, DrawingSizeSnapshot, PrizeAward } from "../domain";
import { ClubService } from "./club-service";
import { PostgresClubRepository, type DbLikeClient } from "./postgres-club-repository";
import { PostgresRetentionCleanup } from "./postgres-retention-cleanup";
import { PostgresOfficialDataRefreshTargetSource } from "./postgres-official-data-refresh-target-source";
import { PostgresClubApiRepository } from "../api/postgres-club-api-repository";
import { buildClubApiServer } from "../api/club-api-server";
import type { OidcIdentity } from "../api/oidc-auth";
import { DrawingCalculationService } from "./drawing-calculation-service";
import { PostgresNotificationEmailDelivery } from "./notification-email-delivery";
import { SnapshotLotteryPrizeEvaluator } from "./lottery-prize-evaluator";

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
      "006_source_retention_metadata.sql",
      "007_notification_delivery.sql",
      "008_notification_delivery_leases.sql",
      "009_user_profile_names.sql",
    ]) {
      const migrationPath = path.resolve(__dirname, "../../database/migrations", migrationName);
      await client.query(fs.readFileSync(migrationPath, "utf8"));
    }

    const ownerId = randomUUID();
    const memberId = randomUUID();
    const unaffiliatedId = randomUUID();
    await client.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)",
      [ownerId, `${ownerId}@integration.test`, "Integration Owner", memberId, `${memberId}@integration.test`, "Integration Member", unaffiliatedId, `${unaffiliatedId}@integration.test`, "Unaffiliated User"]
    );

    const repository = new PostgresClubRepository({
      query: (text: string, params: any[] = []) => client.query(text, params),
    });
    const testDatabaseClient: DbLikeClient = {
      query: (text: string, params: any[] = []) => client.query(text, params),
      transaction: async <T>(operation: (transactionClient: DbLikeClient) => Promise<T>): Promise<T> => {
        await client.query("BEGIN");
        try {
          const result = await operation({ query: (text: string, params: any[] = []) => client.query(text, params) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
    };
    const apiRepository = new PostgresClubApiRepository(testDatabaseClient);
    const linkedOwner = await apiRepository.provisionOidcUser({
      subject: `oidc-${ownerId}`,
      email: `${ownerId}@integration.test`,
      emailVerified: true as const,
      displayName: "OIDC Integration Owner",
      username: "integration.owner",
      firstName: "Integration",
      lastName: "Owner",
    });
    assert.equal(linkedOwner.id, ownerId);
    assert.equal(linkedOwner.authSubject, `oidc-${ownerId}`);
    const newIdentity = {
      subject: `oidc-signup-${randomUUID()}`,
      email: `signup-${randomUUID()}@integration.test`,
      emailVerified: true as const,
      displayName: "Newly Registered Member",
      username: "new.member",
      firstName: "Newly Registered",
      lastName: "Member",
    };
    const createdUser = await apiRepository.provisionOidcUser(newIdentity);
    assert.equal(createdUser.authSubject, newIdentity.subject);
    assert.equal(createdUser.email, newIdentity.email);
    assert.equal(createdUser.status, "active");
    assert.equal(createdUser.username, "new.member");
    assert.equal(createdUser.firstName, "Newly Registered");
    assert.equal(createdUser.lastName, "Member");
    await assert.rejects(apiRepository.provisionOidcUser({
      ...newIdentity,
      subject: `duplicate-${randomUUID()}`,
      email: `duplicate-${randomUUID()}@integration.test`,
      username: "NEW.MEMBER",
    }), /username is already in use/i);
    const replacementIdentity = {
      ...newIdentity,
      subject: `cognito-${newIdentity.subject}`,
    };
    await assert.rejects(
      apiRepository.provisionOidcUser(replacementIdentity),
      /already linked to another sign-in identity/
    );
    const migrationRepository = new PostgresClubApiRepository(testDatabaseClient, true);
    const relinkedUser = await migrationRepository.provisionOidcUser(replacementIdentity);
    assert.equal(relinkedUser.id, createdUser.id);
    assert.equal(relinkedUser.authSubject, replacementIdentity.subject);
    const unverifiedIdentity = {
      ...newIdentity,
      subject: `unverified-${randomUUID()}`,
      email: `unverified-${randomUUID()}@integration.test`,
      emailVerified: false,
    } as unknown as OidcIdentity;
    await assert.rejects(apiRepository.provisionOidcUser(unverifiedIdentity), /verified OIDC identity/);

    const linkedMember = await apiRepository.provisionOidcUser({
      subject: `oidc-${memberId}`,
      email: `${memberId}@integration.test`,
      emailVerified: true,
      displayName: "Integration Member",
      username: "integration.member",
      firstName: "Integration",
      lastName: "Member",
    });
    assert.equal(linkedMember.id, memberId);

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
    await assert.rejects(apiRepository.closeAccount(ownerId), /close your active clubs/i);
    const membership = await service.requestMembership({ clubId: club.club.id, userId: memberId });
    assert.equal(membership.status, "active");
    const publicOverview = await apiRepository.getClubOverview(ownerId, club.club.id);
    assert.equal(publicOverview?.members.find((item) => item.userId === ownerId)?.displayName, "integration.owner");
    assert.equal(publicOverview?.members.find((item) => item.userId === ownerId)?.email, "");
    assert.equal(publicOverview?.members.find((item) => item.userId === memberId)?.displayName, "integration.member");
    assert.deepEqual(await apiRepository.listUserClubs(ownerId), [{ id: club.club.id, name: club.club.name, visibility: "public", role: "creator" }]);
    assert.deepEqual(await apiRepository.listUserClubs(randomUUID()), []);

    const searchableClub = await service.createClub({
      name: "Searchable Private Club",
      description: "This detail must stay private.",
      motto: "Not in search results.",
      visibility: "private",
      allowSearch: true,
      ownerUserId: ownerId,
      supportedLotteries: ["powerball"],
      payoutConfiguration: { type: "equal_shares" },
      thresholdRule: { thresholdAmount: 100, method: "pooled" },
    });
    const joinRequest = await apiRepository.requestMembership(memberId, searchableClub.club.id);
    assert.equal(joinRequest.status, "pending");
    assert.deepEqual(await apiRepository.searchClubs(memberId, "Searchable"), [{
      id: searchableClub.club.id,
      name: searchableClub.club.name,
      visibility: "private",
      membershipStatus: "pending",
    }]);
    const membershipRequests = await apiRepository.listMembershipRequests(ownerId, searchableClub.club.id);
    assert.equal(membershipRequests[0].userId, memberId);
    assert.equal(membershipRequests[0].displayName, "Integration Member");
    await assert.rejects(apiRepository.listMembershipRequests(memberId, searchableClub.club.id), /not an active member/);

    assert.equal((await apiRepository.approveMembership(ownerId, searchableClub.club.id, memberId)).status, "active");
    assert.equal((await apiRepository.updateMembershipRole(ownerId, searchableClub.club.id, memberId, "admin")).role, "admin");
    await assert.rejects(apiRepository.removeMember(memberId, searchableClub.club.id, ownerId), /Only the creator/);

    const guardedDrawingId = randomUUID();
    const guardedContributionId = randomUUID();
    await client.query(
      "INSERT INTO drawings (id, lottery, drawing_date, state, cutoff_time_et, status) VALUES ($1, 'powerball', '2000-01-03', 'MI', '21:58:00', 'calculated')",
      [guardedDrawingId]
    );
    await client.query(
      `INSERT INTO contributions (id, club_id, user_id, lottery, drawing_date, drawing_count, number_sets, cost_usd, status)
       VALUES ($1, $2, $3, 'powerball', '2000-01-03', 1, $4, 2, 'submitted')`,
      [guardedContributionId, searchableClub.club.id, memberId, JSON.stringify([{ numbers: [1, 2, 3, 4, 5], bonusNumber: 6 }])]
    );
    await assert.rejects(apiRepository.removeMember(ownerId, searchableClub.club.id, memberId), /post-cutoff payout calculations/);

    const drawingResultId = randomUUID();
    await client.query(
      "INSERT INTO drawing_results (id, drawing_id, club_id, status) VALUES ($1, $2, $3, 'calculated')",
      [drawingResultId, guardedDrawingId, searchableClub.club.id]
    );
    const pendingAwardId = randomUUID();
    await client.query(
      "INSERT INTO prize_awards (id, drawing_result_id, user_id, club_id, prize_type, status) VALUES ($1, $2, $3, $4, 'drawing_payout', 'pending')",
      [pendingAwardId, drawingResultId, memberId, searchableClub.club.id]
    );
    await assert.rejects(apiRepository.removeMember(ownerId, searchableClub.club.id, memberId), /pending payout/);
    await client.query("UPDATE prize_awards SET status = 'allocated' WHERE id = $1", [pendingAwardId]);
    assert.equal((await apiRepository.removeMember(ownerId, searchableClub.club.id, memberId)).status, "removed");

    const updatedClub = await apiRepository.updateClubSettings(ownerId, club.club.id, {
      name: "Updated Postgres Integration Club",
      description: "Updated description",
      motto: null,
      visibility: "private",
      allowSearch: false,
    });
    assert.equal(updatedClub?.name, "Updated Postgres Integration Club");
    assert.equal(updatedClub?.visibility, "private");
    const privateOverview = await apiRepository.getClubOverview(ownerId, club.club.id);
    assert.equal(privateOverview?.members.find((item) => item.userId === ownerId)?.displayName, "Integration Owner");
    assert.equal(privateOverview?.members.find((item) => item.userId === ownerId)?.email, `${ownerId}@integration.test`);
    assert.equal(privateOverview?.members.find((item) => item.userId === memberId)?.displayName, "Integration Member");
    await assert.rejects(apiRepository.updateClubSettings(memberId, club.club.id, {
      name: "Unauthorized Change",
      description: null,
      motto: null,
      visibility: "public",
      allowSearch: true,
    }), /Only club creators and admins/);
    await apiRepository.updateMembershipRole(ownerId, club.club.id, memberId, "admin");
    await apiRepository.transferClubOwnership(ownerId, club.club.id, memberId);
    const transferredRoles = await client.query(
      "SELECT c.owner_user_id, creator.role AS new_creator_role, previous.role AS previous_owner_role FROM clubs c JOIN club_memberships creator ON creator.club_id = c.id AND creator.user_id = $2 JOIN club_memberships previous ON previous.club_id = c.id AND previous.user_id = $3 WHERE c.id = $1",
      [club.club.id, memberId, ownerId]
    );
    assert.deepEqual(transferredRoles.rows[0], { owner_user_id: memberId, new_creator_role: "creator", previous_owner_role: "admin" });

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
    const provisionedSchedule = await apiRepository.ensureUpcomingDrawings(ownerId, club.club.id, "2026-11-10");
    assert.equal(provisionedSchedule?.length, 30);
    assert.equal(provisionedSchedule?.[0].drawingDate, "2026-11-11");
    assert.equal(provisionedSchedule?.[1].drawingDate, "2026-11-14");
    const repeatedSchedule = await apiRepository.ensureUpcomingDrawings(ownerId, club.club.id, "2026-11-10");
    assert.deepEqual(repeatedSchedule?.map((drawing) => drawing.id), provisionedSchedule?.map((drawing) => drawing.id));
    assert.equal(await apiRepository.ensureUpcomingDrawings(randomUUID(), club.club.id, "2026-11-10"), null);
    const easternDateParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const easternDateValues = Object.fromEntries(easternDateParts.map((part) => [part.type, part.value]));
    const easternToday = `${easternDateValues.year}-${easternDateValues.month}-${easternDateValues.day}`;
    const activeSchedule = await apiRepository.ensureUpcomingDrawings(
      ownerId,
      club.club.id,
      `${easternDateValues.year}-${easternDateValues.month}-${easternDateValues.day}`
    );
    const emptyClubOverview = await apiRepository.getClubOverview(ownerId, club.club.id);
    assert.equal(emptyClubOverview?.contributions.length, 0);
    const nextByLottery = new Map<string, string>();
    for (const drawing of activeSchedule ?? []) {
      if (!nextByLottery.has(drawing.lottery)) nextByLottery.set(drawing.lottery, drawing.id);
    }
    for (const drawing of activeSchedule ?? []) {
      assert.equal(emptyClubOverview?.results.some((item) => item.drawing.id === drawing.id), nextByLottery.get(drawing.lottery) === drawing.id);
    }
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
    const optionsByDate = new Map(options?.map((option) => [option.drawingDate, option]));
    const firstUpcomingDate = activeSchedule?.[0]?.drawingDate;
    assert.ok(firstUpcomingDate);
    assert.equal(optionsByDate.get(firstUpcomingDate)?.ticketPrice, 2);
    assert.equal(optionsByDate.get(firstUpcomingDate)?.numberRules?.mainNumberMax, 69);
    assert.deepEqual(optionsByDate.get(firstUpcomingDate)?.drawingCountOptions, [1, 5, 10, 15, 20, 25, 30].filter((count) => count <= activeSchedule!.length));
    const pastTicketDate = options?.find((option) => option.drawingDate === "2026-11-09");
    assert.equal(pastTicketDate?.existingTicketDate, true);
    assert.equal((await apiRepository.getTicketDrawingOptions(memberId, club.club.id))?.some((option) => option.drawingDate === "2026-11-09"), false);
    for (const drawing of activeSchedule ?? []) assert.equal(optionsByDate.has(drawing.drawingDate), true);
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
    const lateTicketEdit = await apiRepository.updateContribution(ownerId, club.club.id, apiContribution.id, {
      lottery: "powerball",
      drawingDate: "2026-11-09",
      drawingCount: 1,
      numbers: [2, 4, 6, 8, 10],
      bonusNumber: 12,
    });
    assert.equal(lateTicketEdit.contribution.version, apiContribution.version + 1);
    assert.deepEqual(lateTicketEdit.recalculationTargets.map((target) => target.drawingId), [drawingId]);

    const futureDrawing = activeSchedule?.find((drawing) => drawing.lottery === "powerball" && drawing.drawingDate > easternToday);
    assert.ok(futureDrawing);
    const futureSnapshot: CalculationSnapshot = {
      ...snapshot,
      id: randomUUID(),
      drawingId: futureDrawing.id,
      capturedAt: new Date().toISOString(),
      sourceSha256: "f".repeat(64),
      priceSnapshot: {
        ...snapshot.priceSnapshot,
        prizeTiers: [{ mainMatches: 5, bonusMatches: true, prizeType: "jackpot", prizeAmount: 1000000 }],
      },
    };
    const futureResult: DrawingResult = {
      ...result,
      id: randomUUID(),
      drawingId: futureDrawing.id,
      officialWinningNumbers: null,
      jackpotEstimate: null,
      prizeBreakdown: null,
      status: "pending",
      sourceSnapshotId: futureSnapshot.id,
      createdAt: futureSnapshot.capturedAt,
    };
    await repository.storeOfficialData(futureSnapshot, futureResult, null);
    const editableContribution = await apiRepository.createContribution(ownerId, club.club.id, {
      lottery: "powerball",
      drawingDate: futureDrawing.drawingDate,
      drawingCount: 1,
      numberSets: [{ numbers: [1, 3, 5, 7, 9], bonusNumber: 10 }],
    }, photo);
    const editableOverview = await apiRepository.getClubOverview(ownerId, club.club.id);
    assert.equal(editableOverview?.contributions.find((item) => item.id === editableContribution.id)?.canEdit, true);
    assert.equal((await apiRepository.getClubOverview(memberId, club.club.id))?.contributions.find((item) => item.id === editableContribution.id)?.canEdit, false);
    assert.equal(editableOverview?.results.some((item) => item.drawing.id === futureDrawing.id), true);
    const laterPowerballIds = new Set((activeSchedule ?? []).filter((drawing) => drawing.lottery === "powerball" && drawing.drawingDate > futureDrawing.drawingDate).map((drawing) => drawing.id));
    const memberResults = (await apiRepository.getClubOverview(memberId, club.club.id))?.results ?? [];
    assert.equal(memberResults.some((item) => laterPowerballIds.has(item.drawing.id)), false);
    assert.equal(editableOverview?.results.some((item) => laterPowerballIds.has(item.drawing.id)), false);
    const editedContribution = await apiRepository.updateContribution(ownerId, club.club.id, editableContribution.id, {
      lottery: "powerball",
      drawingDate: futureDrawing.drawingDate,
      drawingCount: 1,
      numberSets: [
        { numbers: [2, 4, 6, 8, 10], bonusNumber: 12 },
        { numbers: [1, 3, 5, 7, 9], bonusNumber: 11, powerPlay: true },
      ],
    });
    assert.equal(editedContribution.contribution.version, editableContribution.version + 1);
    assert.equal(editedContribution.contribution.costUsd, 5);
    assert.equal((editedContribution.contribution.numberSets[1] as { powerPlay?: boolean }).powerPlay, true);
    assert.equal(editedContribution.contribution.hasTicketPhoto, true);
    assert.deepEqual(await apiRepository.getContributionPhoto(memberId, club.club.id, editableContribution.id), photo);
    await assert.rejects(apiRepository.updateContribution(memberId, club.club.id, editableContribution.id, {
      lottery: "powerball",
      drawingDate: futureDrawing.drawingDate,
      drawingCount: 1,
      numbers: [2, 4, 6, 8, 10],
      bonusNumber: 12,
    }), /not found or is not owned/);
    const { rows: auditRows } = await client.query(
      "SELECT action, old_value, new_value FROM audit_events WHERE entity_type = 'contribution' AND entity_id = $1",
      [editableContribution.id]
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].action, "updated");
    assert.equal(auditRows[0].old_value.numberSets.length, 1);
    assert.equal(auditRows[0].new_value.numberSets.length, 2);

    const postedResult = {
      ...futureResult,
      officialWinningNumbers: { numbers: [2, 4, 6, 8, 10], bonusNumber: 12 },
      jackpotEstimate: 1000000,
      prizeBreakdown: { jackpot: 1000000 },
      status: "results_posted" as const,
    };
    await repository.storeOfficialData(futureSnapshot, postedResult, now);
    let recalculationError: string | null = null;
    const editApi = await buildClubApiServer({
      repository: apiRepository,
      webOrigin: "https://club.example.test",
      verifyToken: async (token) => ({
        subject: token === "owner" ? `oidc-${ownerId}` : `oidc-${memberId}`,
        email: token === "owner" ? `${ownerId}@integration.test` : `${memberId}@integration.test`,
        emailVerified: true,
        displayName: "Integration Member",
      }),
      recalculateDrawings: async (clubId, targets) => {
        const calculator = new DrawingCalculationService(repository, new SnapshotLotteryPrizeEvaluator());
        try {
          for (const target of targets) await calculator.calculateDrawing({ ...target, clubId, recalculation: true });
        } catch (error) {
          recalculationError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    });
    t.after(() => editApi.close());
    const recalculatedEdit = await editApi.inject({
      method: "PATCH",
      url: `/api/v1/clubs/${club.club.id}/contributions/${editableContribution.id}`,
      headers: { authorization: "Bearer owner" },
      payload: {
        lottery: "powerball",
        drawingDate: futureDrawing.drawingDate,
        drawingCount: 1,
        numberSets: [
          { numbers: [2, 4, 6, 8, 10], bonusNumber: 12 },
          { numbers: [1, 3, 5, 7, 9], bonusNumber: 11 },
        ],
      },
    });
    assert.equal(recalculatedEdit.statusCode, 200);
    assert.equal(recalculatedEdit.json().recalculationPending, false, recalculationError ?? undefined);
    assert.equal(recalculatedEdit.json().recalculatedDrawingCount, 1);
    assert.equal((await repository.findDrawingResultByDrawingAndClub(futureDrawing.id, club.club.id))?.status, "recalculated");
    const recalculatedOverview = await apiRepository.getClubOverview(ownerId, club.club.id);
    assert.equal(recalculatedOverview?.contributions.find((item) => item.id === editableContribution.id)?.canEdit, true);
    assert.equal(recalculatedOverview?.results.find((item) => item.drawing.id === futureDrawing.id)?.payouts.some((payout) => payout.userId === ownerId && payout.grossPrizeAmount === 1000000), true);
    const { rows: finalAuditRows } = await client.query(
      "SELECT COUNT(*)::int AS count FROM audit_events WHERE entity_type = 'contribution' AND entity_id = $1",
      [editableContribution.id]
    );
    assert.equal(finalAuditRows[0].count, 2);

    await assert.rejects(apiRepository.createContribution(ownerId, club.club.id, {
      lottery: "powerball",
      drawingDate: "2026-11-09",
      drawingCount: 1,
      numbers: [2, 4, 6, 8, 10],
      bonusNumber: 12,
    }, { data: Buffer.alloc(5 * 1024 * 1024 + 1), contentType: "image/png" }));
    const contributionCount = await client.query("SELECT COUNT(*)::int AS count FROM contributions WHERE club_id = $1", [club.club.id]);
    assert.equal(contributionCount.rows[0].count, 3);

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
    await repository.replacePrizeAwardsAndCompleteResult(stored.result.id, [award], "calculated", now, [{
      userId: ownerId,
      clubId: club.club.id,
      drawingId,
      type: "payout_calculated",
      message: "Test Club: Powerball payout calculated.",
    }]);
    const persistedResult = await repository.findDrawingResultByDrawingAndClub(drawingId, club.club.id);
    assert.equal(persistedResult?.status, "calculated");
    const calculationNotifications = await client.query(
      "SELECT channel, status FROM notifications WHERE user_id = $1 AND drawing_id = $2 ORDER BY channel",
      [ownerId, drawingId]
    );
    assert.deepEqual(calculationNotifications.rows, [{ channel: "in_app", status: "sent" }, { channel: "email", status: "queued" }]);

    const deliveredEmails: Array<{ to: string; subject: string; text: string }> = [];
    const notificationDelivery = new PostgresNotificationEmailDelivery({
      query: (text: string, params: any[] = []) => client.query(text, params),
      transaction: async (operation) => {
        await client.query("BEGIN");
        try {
          const value = await operation({ query: (text: string, params: any[] = []) => client.query(text, params) });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
    }, { send: async (email) => { deliveredEmails.push(email); } });
    const deliverySummary = await notificationDelivery.deliverQueued();
    assert.ok(deliverySummary.sent >= 1);
    assert.equal(deliveredEmails.some((email) => email.to === `${ownerId}@integration.test`), true);
    const sentEmail = await client.query(
      "SELECT status, delivery_attempts, sent_at FROM notifications WHERE user_id = $1 AND drawing_id = $2 AND channel = 'email'",
      [ownerId, drawingId]
    );
    assert.equal(sentEmail.rows[0].status, "sent");
    assert.equal(sentEmail.rows[0].delivery_attempts, 1);
    assert.ok(sentEmail.rows[0].sent_at);
    const defaultPreferences = await apiRepository.getNotificationPreferences(ownerId);
    assert.equal(defaultPreferences.inAppEnabled, true);
    assert.equal(defaultPreferences.emailEnabled, true);
    const inbox = await apiRepository.listNotifications(ownerId);
    const payoutNotice = inbox.find((notification) => notification.drawingId === drawingId);
    assert.ok(payoutNotice);
    assert.equal(await apiRepository.markNotificationRead(ownerId, payoutNotice.id), true);
    const readNotice = (await apiRepository.listNotifications(ownerId)).find((notification) => notification.id === payoutNotice.id);
    assert.ok(readNotice?.readAt);
    const savedPreferences = await apiRepository.updateNotificationPreferences(ownerId, { inAppEnabled: true, emailEnabled: false });
    assert.equal(savedPreferences.emailEnabled, false);

    const failedNotificationId = randomUUID();
    await client.query(
      `INSERT INTO notifications (id, user_id, club_id, drawing_id, type, channel, status, message)
       VALUES ($1, $2, $3, $4, 'payout_calculated', 'email', 'queued', 'Retry test notification')`,
      [failedNotificationId, memberId, club.club.id, drawingId]
    );
    const failingDelivery = new PostgresNotificationEmailDelivery(testDatabaseClient, {
      async send() {
        const error = new Error("Temporary SMTP failure") as Error & { code: string };
        error.code = "ETIMEDOUT";
        throw error;
      },
    });
    for (let attempt = 0; attempt < 5; attempt++) await failingDelivery.deliverQueued();
    const failedNotification = await client.query(
      "SELECT status, delivery_attempts, last_error FROM notifications WHERE id = $1",
      [failedNotificationId]
    );
    assert.equal(failedNotification.rows[0].status, "failed");
    assert.equal(failedNotification.rows[0].delivery_attempts, 5);
    assert.equal(failedNotification.rows[0].last_error, "ETIMEDOUT");

    const overview = await apiRepository.getClubOverview(ownerId, club.club.id);
    assert.equal(overview?.currentUser.id, ownerId);
    assert.equal(overview?.contributions.length, 3);
    assert.equal(overview?.contributions.find((item) => item.id === apiContribution.id)?.hasTicketPhoto, true);
    assert.equal(overview?.totalContributionsUsd, 10);
    assert.deepEqual(overview?.results.find((item) => item.drawing.id === drawingId)?.payouts.map((payout) => [payout.userId, payout.grossPrizeAmount, payout.shareAmount]), [[ownerId, 100, 100]]);

    const { rows } = await client.query("SELECT id, share_amount FROM prize_awards WHERE drawing_result_id = $1", [stored.result.id]);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].share_amount), 100);

    const preparedDrawingIds: string[] = [];
    const onboardingApi = await buildClubApiServer({
      repository: apiRepository,
      webOrigin: "https://club.example.test",
      verifyToken: async () => ({
        subject: `oidc-${ownerId}`,
        email: `${ownerId}@integration.test`,
        emailVerified: true,
        displayName: "Integration Owner",
      }),
      prepareTicketDrawings: async (_userId, _clubId, drawings) => {
        preparedDrawingIds.push(...drawings.map((drawing) => drawing.id));
      },
    });
    t.after(() => onboardingApi.close());
    const createdClubResponse = await onboardingApi.inject({
      method: "POST",
      url: "/api/v1/clubs",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        name: "First Ticket Club",
        visibility: "private",
        supportedLotteries: ["powerball", "mega_millions"],
        payoutConfiguration: { type: "equal_shares" },
        thresholdRule: { thresholdAmount: 100, method: "pooled" },
      },
    });
    assert.equal(createdClubResponse.statusCode, 201);
    assert.deepEqual(createdClubResponse.json().club.supportedLotteries, ["powerball", "mega_millions"]);
    assert.equal(createdClubResponse.json().contributions.length, 0);
    assert.equal(preparedDrawingIds.length, 2);
    assert.equal(["powerball", "mega_millions"].every((lottery) => createdClubResponse.json().results.filter((item: any) => item.drawing.lottery === lottery).length === 1), true);

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
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="contribution"\r\n\r\n${JSON.stringify({ lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 5, numberSets: [{ numbers: [2, 4, 6, 8, 10], bonusNumber: 12 }, { numbers: [1, 3, 5, 7, 9], bonusNumber: 11 }] })}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="ticket.png"\r\nContent-Type: image/png\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const baseUrl = `/api/v1/clubs/${club.club.id}/contributions`;
    const uploaded = await api.inject({ method: "POST", url: baseUrl, headers: { authorization: "Bearer owner", "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(uploaded.statusCode, 201);
    assert.equal(uploaded.json().hasTicketPhoto, true);
    assert.equal(uploaded.json().numberSets.length, 2);
    assert.equal(uploaded.json().costUsd, 20);
    const photoUrl = `${baseUrl}/${uploaded.json().id}/photo`;
    assert.equal((await api.inject({ method: "GET", url: photoUrl })).statusCode, 401);
    assert.equal((await api.inject({ method: "GET", url: photoUrl, headers: { authorization: "Bearer outsider" } })).statusCode, 404);
    const retrieved = await api.inject({ method: "GET", url: photoUrl, headers: { authorization: "Bearer owner" } });
    assert.equal(retrieved.statusCode, 200);
    assert.deepEqual(retrieved.rawPayload, image);

    const blockedOwnerClosure = await api.inject({ method: "POST", url: "/api/v1/me/close", headers: { authorization: "Bearer owner" } });
    assert.equal(blockedOwnerClosure.statusCode, 409);
    const closedClub = await api.inject({ method: "POST", url: `/api/v1/clubs/${searchableClub.club.id}/close`, headers: { authorization: "Bearer owner" } });
    assert.equal(closedClub.statusCode, 204);
    const closedClubRow = await client.query("SELECT status FROM clubs WHERE id = $1", [searchableClub.club.id]);
    assert.equal(closedClubRow.rows[0].status, "closed");

    await client.query("UPDATE clubs SET closed_at = NOW() - INTERVAL '13 months' WHERE id = $1", [searchableClub.club.id]);
    await client.query(
      "UPDATE calculation_snapshots SET captured_at = NOW() - INTERVAL '13 months', source_document = 'expired rules source body' WHERE club_id = $1 AND source_document IS NOT NULL",
      [club.club.id]
    );
    await client.query(
      "UPDATE drawing_results SET official_source_captured_at = NOW() - INTERVAL '13 months', official_source_document = 'expired result source body' WHERE club_id = $1 AND official_source_document IS NOT NULL",
      [club.club.id]
    );
    await client.query(
      "UPDATE drawings SET drawing_size_captured_at = NOW() - INTERVAL '13 months', drawing_size_source_document = 'expired estimate source body' WHERE id = $1",
      [drawingId]
    );
    const cleanup = new PostgresRetentionCleanup(testDatabaseClient);
    const preview = await cleanup.preview();
    assert.ok(preview.calculationSourceBodies > 0);
    assert.ok(preview.resultSourceBodies > 0);
    assert.ok(preview.drawingSizeSourceBodies > 0);
    assert.equal(preview.closedClubs, 1);
    assert.equal((await client.query("SELECT id FROM clubs WHERE id = $1", [searchableClub.club.id])).rows.length, 1);
    assert.equal((await client.query(
      "SELECT source_document FROM calculation_snapshots WHERE club_id = $1 AND source_document = 'expired rules source body' LIMIT 1",
      [club.club.id]
    )).rows.length > 0, true);

    const cleanupResult = await cleanup.apply();
    assert.equal(cleanupResult.closedClubs, 1);
    const retainedSnapshot = await client.query(
      "SELECT source_document, source_sha256, price_snapshot FROM calculation_snapshots WHERE club_id = $1 AND source_sha256 IS NOT NULL ORDER BY captured_at LIMIT 1",
      [club.club.id]
    );
    assert.equal(retainedSnapshot.rows[0].source_document, null);
    assert.ok(retainedSnapshot.rows[0].source_sha256);
    assert.ok(retainedSnapshot.rows[0].price_snapshot);
    const retainedResult = await client.query(
      "SELECT official_source_document, official_source_sha256, official_source_captured_at FROM drawing_results WHERE club_id = $1 ORDER BY created_at LIMIT 1",
      [club.club.id]
    );
    assert.equal(retainedResult.rows[0].official_source_document, null);
    assert.ok(retainedResult.rows[0].official_source_sha256);
    assert.ok(retainedResult.rows[0].official_source_captured_at);
    const retainedEstimate = await client.query(
      "SELECT drawing_size_source_document, drawing_size_source_sha256, drawing_size_captured_at FROM drawings WHERE id = $1",
      [drawingId]
    );
    assert.equal(retainedEstimate.rows[0].drawing_size_source_document, null);
    assert.ok(retainedEstimate.rows[0].drawing_size_source_sha256);
    assert.ok(retainedEstimate.rows[0].drawing_size_captured_at);
    assert.equal((await client.query("SELECT id FROM clubs WHERE id = $1", [searchableClub.club.id])).rows.length, 0);
    assert.equal((await client.query("SELECT id FROM drawing_results WHERE club_id = $1", [searchableClub.club.id])).rows.length, 0);
    await apiRepository.closeAccount(unaffiliatedId);
    const closedUser = await client.query("SELECT status, closed_at FROM users WHERE id = $1", [unaffiliatedId]);
    assert.equal(closedUser.rows[0].status, "closed");
    assert.ok(closedUser.rows[0].closed_at);
  }
);
