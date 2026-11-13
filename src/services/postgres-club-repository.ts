import type {
  CalculationSnapshot,
  Club,
  ClubMembership,
  Contribution,
  Drawing,
  DrawingSizeSnapshot,
  DrawingResult,
  LotteryType,
  PayoutConfiguration,
  PrizeAward,
  ThresholdRule,
} from "../domain";
import type { ClubRepository } from "./club-service";

export type QueryResultLike = {
  rows: Array<Record<string, any>>;
};

export type DbLikeClient = {
  query: (text: string, params?: any[]) => Promise<QueryResultLike>;
  transaction?: <T>(operation: (client: DbLikeClient) => Promise<T>) => Promise<T>;
};

export class PostgresClubRepository implements ClubRepository {
  constructor(private readonly client: DbLikeClient) {}

  async createClub(club: Club): Promise<Club> {
    const { rows } = await this.client.query(
      `
        INSERT INTO clubs (
          id,
          name,
          description,
          motto,
          visibility,
          owner_user_id,
          status,
          payout_configuration_id,
          threshold_rule_id,
          supported_lotteries,
          allow_search,
          created_at,
          updated_at,
          closed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *, supported_lotteries::text[] AS supported_lotteries
      `,
      [
        club.id,
        club.name,
        club.description,
        club.motto,
        club.visibility,
        club.ownerUserId,
        club.status,
        club.payoutConfigurationId,
        club.thresholdRuleId,
        club.supportedLotteries,
        club.allowSearch,
        club.createdAt,
        club.updatedAt,
        club.closedAt,
      ]
    );

    return PostgresClubRepository.toClub(rows[0]);
  }

  async updateClub(club: Club): Promise<Club> {
    const { rows } = await this.client.query(
      `
        UPDATE clubs
        SET
          name = $2,
          description = $3,
          motto = $4,
          visibility = $5,
          owner_user_id = $6,
          status = $7,
          payout_configuration_id = $8,
          threshold_rule_id = $9,
          supported_lotteries = $10,
          allow_search = $11,
          updated_at = $12,
          closed_at = $13
        WHERE id = $1
        RETURNING *, supported_lotteries::text[] AS supported_lotteries
      `,
      [
        club.id,
        club.name,
        club.description,
        club.motto,
        club.visibility,
        club.ownerUserId,
        club.status,
        club.payoutConfigurationId,
        club.thresholdRuleId,
        club.supportedLotteries,
        club.allowSearch,
        club.updatedAt,
        club.closedAt,
      ]
    );

    return PostgresClubRepository.toClub(rows[0]);
  }

  async findClubById(clubId: string): Promise<Club | null> {
    const { rows } = await this.client.query(
      "SELECT *, supported_lotteries::text[] AS supported_lotteries FROM clubs WHERE id = $1 LIMIT 1",
      [clubId]
    );

    return rows[0] ? PostgresClubRepository.toClub(rows[0]) : null;
  }

  async findDrawingById(drawingId: string): Promise<Drawing | null> {
    const { rows } = await this.client.query("SELECT * FROM drawings WHERE id = $1 LIMIT 1", [drawingId]);
    return rows[0] ? PostgresClubRepository.toDrawing(rows[0]) : null;
  }

  async findDrawingsByLottery(lottery: LotteryType): Promise<Drawing[]> {
    const { rows } = await this.client.query(
      "SELECT * FROM drawings WHERE lottery = $1 ORDER BY drawing_date ASC",
      [lottery]
    );
    return rows.map(PostgresClubRepository.toDrawing);
  }

  async findOfficialDataRefreshTargets(
    asOfDate: string,
    lookbackDays = 30
  ): Promise<Array<{ drawingId: string; clubId: string }>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      throw new Error("Refresh target date must use YYYY-MM-DD format.");
    }
    if (!Number.isInteger(lookbackDays) || lookbackDays < 0) {
      throw new Error("Refresh target lookback must be a nonnegative integer.");
    }

    const { rows } = await this.client.query(
      `
        WITH ranked_drawings AS (
          SELECT
            id,
            lottery,
            drawing_date,
            ROW_NUMBER() OVER (PARTITION BY lottery ORDER BY drawing_date) AS draw_sequence
          FROM drawings
        ),
        next_drawings AS (
          SELECT DISTINCT ON (lottery) id, lottery
          FROM ranked_drawings
          WHERE drawing_date >= $1::date
          ORDER BY lottery, drawing_date
        )
        SELECT DISTINCT d.id AS drawing_id, c.id AS club_id, d.drawing_date
        FROM clubs c
        JOIN ranked_drawings d ON d.lottery = ANY(c.supported_lotteries)
        LEFT JOIN drawing_results r ON r.drawing_id = d.id AND r.club_id = c.id
        WHERE c.status = 'active'
          AND EXISTS (
            SELECT 1
            FROM contributions contribution
            JOIN ranked_drawings start_drawing
              ON start_drawing.lottery = contribution.lottery
             AND start_drawing.drawing_date = contribution.drawing_date
            WHERE contribution.club_id = c.id
              AND contribution.lottery = d.lottery
              AND contribution.status NOT IN ('draft', 'archived')
              AND start_drawing.draw_sequence <= d.draw_sequence
              AND start_drawing.draw_sequence + contribution.drawing_count > d.draw_sequence
          )
          AND (
            (
              d.drawing_date BETWEEN $1::date - $2::int AND $1::date
              AND (r.id IS NULL OR r.status IN ('pending', 'results_posted'))
            )
            OR d.id = (SELECT next_drawing.id FROM next_drawings next_drawing WHERE next_drawing.lottery = d.lottery)
          )
        ORDER BY d.drawing_date, c.id
      `,
      [asOfDate, lookbackDays]
    );

    return rows.map((row) => ({ drawingId: row.drawing_id, clubId: row.club_id }));
  }

  async findDrawingResultByDrawingAndClub(drawingId: string, clubId: string): Promise<DrawingResult | null> {
    const { rows } = await this.client.query(
      "SELECT * FROM drawing_results WHERE drawing_id = $1 AND club_id = $2 ORDER BY created_at DESC LIMIT 1",
      [drawingId, clubId]
    );
    return rows[0] ? PostgresClubRepository.toDrawingResult(rows[0]) : null;
  }

  async findCalculationSnapshotById(snapshotId: string): Promise<CalculationSnapshot | null> {
    const { rows } = await this.client.query(
      "SELECT * FROM calculation_snapshots WHERE id = $1 LIMIT 1",
      [snapshotId]
    );
    return rows[0] ? PostgresClubRepository.toCalculationSnapshot(rows[0]) : null;
  }

  async storeOfficialData(
    snapshot: CalculationSnapshot,
    result: DrawingResult,
    officialResultPostedAt: string | null,
    drawingSize: DrawingSizeSnapshot | null = null
  ): Promise<{
    snapshot: CalculationSnapshot;
    result: DrawingResult;
    rulesChanged: boolean;
    resultChanged: boolean;
    drawingSizeUpdated: boolean;
    recalculationRequired?: boolean;
  }> {
    await this.client.query("BEGIN");
    try {
      const { rows: latestSnapshotRows } = await this.client.query(
        "SELECT * FROM calculation_snapshots WHERE drawing_id = $1 AND club_id = $2 ORDER BY captured_at DESC LIMIT 1",
        [snapshot.drawingId, snapshot.clubId]
      );
      const previousSnapshot = latestSnapshotRows[0]
        ? PostgresClubRepository.toCalculationSnapshot(latestSnapshotRows[0])
        : null;

      const { rows: previousResultRows } = await this.client.query(
        "SELECT * FROM drawing_results WHERE drawing_id = $1 AND club_id = $2 LIMIT 1",
        [result.drawingId, result.clubId]
      );
      const previousResult = previousResultRows[0]
        ? PostgresClubRepository.toDrawingResult(previousResultRows[0])
        : null;
      const resultChanged = !PostgresClubRepository.sameOfficialResult(previousResult, result);

      let storedSnapshot: CalculationSnapshot;
      let rulesChanged = false;
      const { rows: sameSourceRows } = await this.client.query(
        "SELECT * FROM calculation_snapshots WHERE drawing_id = $1 AND club_id = $2 AND source_sha256 = $3 LIMIT 1",
        [snapshot.drawingId, snapshot.clubId, snapshot.sourceSha256]
      );
      if (sameSourceRows[0]) {
        const sameSourceSnapshot = PostgresClubRepository.toCalculationSnapshot(sameSourceRows[0]);
        const normalizedRulesChanged = !PostgresClubRepository.sameRules(sameSourceSnapshot, snapshot);
        const calculationIsComplete = previousResult?.status === "calculated" || previousResult?.status === "recalculated";
        if (normalizedRulesChanged && !calculationIsComplete) {
          const { rows } = await this.client.query(
            `UPDATE calculation_snapshots
             SET rules_version = $2, price_snapshot = $3::jsonb, captured_at = $4
             WHERE id = $1
             RETURNING *`,
            [sameSourceSnapshot.id, snapshot.rulesVersion, JSON.stringify(snapshot.priceSnapshot), snapshot.capturedAt]
          );
          storedSnapshot = PostgresClubRepository.toCalculationSnapshot(rows[0]);
          rulesChanged = true;
        } else {
          storedSnapshot = sameSourceSnapshot;
        }
      } else {
        rulesChanged = !previousSnapshot || !PostgresClubRepository.sameRules(previousSnapshot, snapshot);
        const { rows } = await this.client.query(
          `
            INSERT INTO calculation_snapshots (
              id, drawing_id, club_id, lottery, rules_url, rules_version, price_snapshot,
                source_document_url, source_content_type, source_document, source_sha256, captured_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
          `,
          [
            snapshot.id,
            snapshot.drawingId,
            snapshot.clubId,
            snapshot.lottery,
            snapshot.rulesUrl,
            snapshot.rulesVersion,
            JSON.stringify(snapshot.priceSnapshot),
            snapshot.sourceDocumentUrl ?? null,
            snapshot.sourceContentType ?? null,
            snapshot.sourceDocument ?? null,
            snapshot.sourceSha256 ?? null,
            snapshot.capturedAt,
          ]
        );
        storedSnapshot = PostgresClubRepository.toCalculationSnapshot(rows[0]);
      }

      const recalculationRequired = Boolean(
        previousResult && (rulesChanged || resultChanged) &&
        (previousResult.status === "calculated" || previousResult.status === "recalculated")
      );
      const invalidated = Boolean(previousResult && (rulesChanged || resultChanged));
      const nextStatus = invalidated
        ? result.officialWinningNumbers ? "results_posted" : "pending"
        : previousResult?.status ?? result.status;
      const nextCalculationStartedAt = invalidated ? null : previousResult?.calculationStartedAt ?? result.calculationStartedAt ?? null;
      const nextCalculatedAt = invalidated ? null : previousResult?.calculatedAt ?? result.calculatedAt ?? null;
      const storedResultInput: DrawingResult = {
        ...result,
        id: previousResult?.id ?? result.id,
        sourceSnapshotId: storedSnapshot.id,
        status: nextStatus,
        calculationStartedAt: nextCalculationStartedAt,
        calculatedAt: nextCalculatedAt,
      };

      if (invalidated && previousResult) {
        await this.client.query("DELETE FROM prize_awards WHERE drawing_result_id = $1", [previousResult.id]);
      }

      let storedResult: DrawingResult;
      if (previousResult) {
        const { rows } = await this.client.query(
          `
            UPDATE drawing_results
            SET official_winning_numbers = $2, jackpot_estimate = $3, prize_breakdown = $4,
                official_source_url = $5, official_source_content_type = $6,
                official_source_document = $7, official_source_sha256 = $8,
                status = $9, calculation_started_at = $10, calculated_at = $11,
                source_snapshot_id = $12
            WHERE id = $1
            RETURNING *
          `,
          [
            storedResultInput.id,
            JSON.stringify(storedResultInput.officialWinningNumbers ?? null),
            storedResultInput.jackpotEstimate ?? null,
            JSON.stringify(storedResultInput.prizeBreakdown ?? null),
            storedResultInput.officialSourceUrl ?? null,
            storedResultInput.officialSourceContentType ?? null,
            storedResultInput.officialSourceDocument ?? null,
            storedResultInput.officialSourceSha256 ?? null,
            storedResultInput.status,
            storedResultInput.calculationStartedAt,
            storedResultInput.calculatedAt,
            storedSnapshot.id,
          ]
        );
        storedResult = PostgresClubRepository.toDrawingResult(rows[0]);
      } else {
        const { rows } = await this.client.query(
          `
            INSERT INTO drawing_results (
              id, drawing_id, club_id, official_winning_numbers, jackpot_estimate, prize_breakdown,
              official_source_url, official_source_content_type, official_source_document,
              official_source_sha256, status, calculation_started_at, calculated_at,
              source_snapshot_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING *
          `,
          [
            storedResultInput.id,
            storedResultInput.drawingId,
            storedResultInput.clubId,
            JSON.stringify(storedResultInput.officialWinningNumbers ?? null),
            storedResultInput.jackpotEstimate ?? null,
            JSON.stringify(storedResultInput.prizeBreakdown ?? null),
            storedResultInput.officialSourceUrl ?? null,
            storedResultInput.officialSourceContentType ?? null,
            storedResultInput.officialSourceDocument ?? null,
            storedResultInput.officialSourceSha256 ?? null,
            storedResultInput.status,
            storedResultInput.calculationStartedAt,
            storedResultInput.calculatedAt,
            storedSnapshot.id,
            storedResultInput.createdAt,
          ]
        );
        storedResult = PostgresClubRepository.toDrawingResult(rows[0]);
      }

      await this.client.query(
        `
          UPDATE drawings
          SET status = CASE
                WHEN $2 THEN 'results_posted'::drawing_status
                ELSE 'pending'::drawing_status
              END,
              official_result_posted_at = CASE
                WHEN $2 THEN COALESCE($3, official_result_posted_at)
                ELSE NULL
              END
          WHERE id = $1
        `,
        [snapshot.drawingId, Boolean(storedResult.officialWinningNumbers), officialResultPostedAt]
      );

      let drawingSizeUpdated = false;
      if (drawingSize) {
        const { rows: drawingRows } = await this.client.query("SELECT * FROM drawings WHERE id = $1 LIMIT 1", [snapshot.drawingId]);
        if (!drawingRows[0]) {
          throw new Error("Drawing not found while storing jackpot estimate.");
        }
        const previousDrawing = PostgresClubRepository.toDrawing(drawingRows[0]);
        if (previousDrawing.drawingDate !== drawingSize.drawingDate) {
          throw new Error("Jackpot estimate drawing date does not match the stored drawing.");
        }
        drawingSizeUpdated = previousDrawing.estimatedJackpot !== drawingSize.estimatedJackpot ||
          previousDrawing.cashValue !== drawingSize.cashValue ||
          previousDrawing.drawingSizeSourceSha256 !== drawingSize.sourceSha256;
        await this.client.query(
          `
            UPDATE drawings
            SET estimated_jackpot = $2,
                cash_value = $3,
                drawing_size_source_url = $4,
                drawing_size_source_content_type = $5,
                drawing_size_source_document = $6,
                drawing_size_source_sha256 = $7,
                drawing_size_captured_at = $8
            WHERE id = $1
          `,
          [
            snapshot.drawingId,
            drawingSize.estimatedJackpot,
            drawingSize.cashValue,
            drawingSize.sourceUrl,
            drawingSize.sourceContentType,
            drawingSize.sourceDocument,
            drawingSize.sourceSha256,
            drawingSize.capturedAt,
          ]
        );
      }

      await this.client.query("COMMIT");
      return { snapshot: storedSnapshot, result: storedResult, rulesChanged, resultChanged, drawingSizeUpdated, recalculationRequired };
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async findPayoutConfigurationByClub(clubId: string): Promise<PayoutConfiguration | null> {
    const { rows } = await this.client.query(
      "SELECT * FROM payout_configurations WHERE club_id = $1 LIMIT 1",
      [clubId]
    );
    return rows[0] ? PostgresClubRepository.toPayoutConfiguration(rows[0]) : null;
  }

  async findThresholdRuleByClub(clubId: string): Promise<ThresholdRule | null> {
    const { rows } = await this.client.query(
      "SELECT * FROM threshold_rules WHERE club_id = $1 LIMIT 1",
      [clubId]
    );
    return rows[0] ? PostgresClubRepository.toThresholdRule(rows[0]) : null;
  }

  async createMembership(membership: ClubMembership): Promise<ClubMembership> {
    const { rows } = await this.client.query(
      `
        INSERT INTO club_memberships (
          id,
          club_id,
          user_id,
          role,
          status,
          joined_at,
          approved_at,
          removed_at,
          removed_by_user_id,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `,
      [
        membership.id,
        membership.clubId,
        membership.userId,
        membership.role,
        membership.status,
        membership.joinedAt,
        membership.approvedAt,
        membership.removedAt,
        membership.removedByUserId,
        membership.createdAt,
        membership.updatedAt,
      ]
    );

    return PostgresClubRepository.toMembership(rows[0]);
  }

  async updateMembership(membership: ClubMembership): Promise<ClubMembership> {
    const { rows } = await this.client.query(
      `
        UPDATE club_memberships
        SET
          club_id = $2,
          user_id = $3,
          role = $4,
          status = $5,
          joined_at = $6,
          approved_at = $7,
          removed_at = $8,
          removed_by_user_id = $9,
          updated_at = $10
        WHERE id = $1
        RETURNING *
      `,
      [
        membership.id,
        membership.clubId,
        membership.userId,
        membership.role,
        membership.status,
        membership.joinedAt,
        membership.approvedAt,
        membership.removedAt,
        membership.removedByUserId,
        membership.updatedAt,
      ]
    );

    return PostgresClubRepository.toMembership(rows[0]);
  }

  async findMembershipByClubAndUser(clubId: string, userId: string): Promise<ClubMembership | null> {
    const { rows } = await this.client.query(
      "SELECT * FROM club_memberships WHERE club_id = $1 AND user_id = $2 LIMIT 1",
      [clubId, userId]
    );

    return rows[0] ? PostgresClubRepository.toMembership(rows[0]) : null;
  }

  async findMembershipsByClub(clubId: string): Promise<ClubMembership[]> {
    const { rows } = await this.client.query(
      "SELECT * FROM club_memberships WHERE club_id = $1 ORDER BY joined_at ASC",
      [clubId]
    );

    return rows.map(PostgresClubRepository.toMembership);
  }

  async createPayoutConfiguration(config: PayoutConfiguration): Promise<PayoutConfiguration> {
    const { rows } = await this.client.query(
      "INSERT INTO payout_configurations (id, club_id, type, version, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [config.id, config.clubId, config.type, config.version, config.createdAt]
    );

    return PostgresClubRepository.toPayoutConfiguration(rows[0]);
  }

  async createThresholdRule(rule: ThresholdRule): Promise<ThresholdRule> {
    const { rows } = await this.client.query(
      "INSERT INTO threshold_rules (id, club_id, threshold_amount, method, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [rule.id, rule.clubId, rule.thresholdAmount, rule.method, rule.createdAt]
    );

    return PostgresClubRepository.toThresholdRule(rows[0]);
  }

  async hasFutureContributionForUserInClub(userId: string, clubId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM contributions
          WHERE user_id = $1
            AND club_id = $2
            AND drawing_date > CURRENT_DATE
            AND status IN ('submitted', 'calculated', 'recalculated')
        ) AS exists
      `,
      [userId, clubId]
    );

    return Boolean(rows[0]?.exists);
  }

  async hasPendingPayoutForUserInClub(userId: string, clubId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      "SELECT EXISTS (SELECT 1 FROM prize_awards WHERE user_id = $1 AND club_id = $2 AND status = 'pending') AS exists",
      [userId, clubId]
    );
    return Boolean(rows[0]?.exists);
  }

  async hasCutoffCalculationInProgress(clubId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM drawings d
          LEFT JOIN drawing_results r ON r.drawing_id = d.id AND r.club_id = $1
          WHERE ((d.drawing_date + d.cutoff_time_et) AT TIME ZONE 'America/New_York') < NOW()
            AND (r.status IS NULL OR r.status NOT IN ('calculated', 'recalculated'))
            AND EXISTS (
              SELECT 1
              FROM contributions c
              WHERE c.club_id = $1
                AND c.lottery = d.lottery
                AND c.status IN ('submitted', 'calculated', 'recalculated')
                AND c.drawing_date <= d.drawing_date
                AND (
                  SELECT COUNT(*)
                  FROM drawings covered
                  WHERE covered.lottery = c.lottery
                    AND covered.drawing_date >= c.drawing_date
                    AND covered.drawing_date <= d.drawing_date
                ) <= c.drawing_count
            )
        ) AS exists
      `,
      [clubId]
    );
    return Boolean(rows[0]?.exists);
  }

  async hasIncompletePayouts(clubId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM drawing_results
          WHERE club_id = $1
            AND status IN ('pending', 'results_posted')
        ) AS exists
      `,
      [clubId]
    );

    return Boolean(rows[0]?.exists);
  }

  async findContributionsForClub(clubId: string): Promise<Contribution[]> {
    const { rows } = await this.client.query(
      "SELECT * FROM contributions WHERE club_id = $1 ORDER BY drawing_date ASC",
      [clubId]
    );

    return rows.map(PostgresClubRepository.toContribution);
  }

  async replacePrizeAwardsAndCompleteResult(
    resultId: string,
    awards: PrizeAward[],
    status: "calculated" | "recalculated",
    calculatedAt: string
  ): Promise<PrizeAward[]> {
    await this.client.query("BEGIN");
    try {
      await this.client.query("DELETE FROM prize_awards WHERE drawing_result_id = $1", [resultId]);
      const savedAwards: PrizeAward[] = [];

      for (const award of awards) {
        const { rows } = await this.client.query(
          `
            INSERT INTO prize_awards (
              id, drawing_result_id, contribution_id, user_id, club_id, prize_type,
              gross_prize_amount, share_amount, threshold_met, payout_type, status,
              created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
          `,
          [
            award.id,
            award.drawingResultId,
            award.contributionId ?? null,
            award.userId ?? null,
            award.clubId,
            award.prizeType,
            award.grossPrizeAmount,
            award.shareAmount,
            award.thresholdMet,
            award.payoutType ?? null,
            award.status,
            award.createdAt,
            award.updatedAt,
          ]
        );
        savedAwards.push(PostgresClubRepository.toPrizeAward(rows[0]));
      }

      await this.client.query(
        `
          UPDATE drawing_results
          SET status = $2, calculation_started_at = COALESCE(calculation_started_at, $3), calculated_at = $3
          WHERE id = $1
        `,
        [resultId, status, calculatedAt]
      );
      await this.client.query("COMMIT");
      return savedAwards;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  private static toClub(row: Record<string, any>): Club {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      motto: row.motto ?? null,
      visibility: row.visibility,
      ownerUserId: row.owner_user_id,
      status: row.status,
      payoutConfigurationId: row.payout_configuration_id ?? null,
      thresholdRuleId: row.threshold_rule_id ?? null,
      supportedLotteries: Array.isArray(row.supported_lotteries)
        ? row.supported_lotteries
        : [],
      allowSearch: row.allow_search,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at ?? null,
    };
  }

  private static toMembership(row: Record<string, any>): ClubMembership {
    return {
      id: row.id,
      clubId: row.club_id,
      userId: row.user_id,
      role: row.role,
      status: row.status,
      joinedAt: row.joined_at,
      approvedAt: row.approved_at ?? null,
      removedAt: row.removed_at ?? null,
      removedByUserId: row.removed_by_user_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static toPayoutConfiguration(row: Record<string, any>): PayoutConfiguration {
    return {
      id: row.id,
      clubId: row.club_id,
      type: row.type,
      version: row.version,
      createdAt: row.created_at,
    };
  }

  private static toThresholdRule(row: Record<string, any>): ThresholdRule {
    return {
      id: row.id,
      clubId: row.club_id,
      thresholdAmount: Number(row.threshold_amount),
      method: row.method,
      createdAt: row.created_at,
    };
  }

  private static toContribution(row: Record<string, any>): Contribution {
    return {
      id: row.id,
      clubId: row.club_id,
      userId: row.user_id,
      lottery: row.lottery,
      drawingDate: PostgresClubRepository.toDateOnly(row.drawing_date),
      drawingCount: Number(row.drawing_count),
      numberSets: Array.isArray(row.number_sets) ? row.number_sets : [],
      ticketImageUrl: row.ticket_image_url ?? null,
      costUsd: Number(row.cost_usd),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: Number(row.version),
    };
  }

  private static toDrawing(row: Record<string, any>): Drawing {
    return {
      id: row.id,
      lottery: row.lottery,
      drawingDate: PostgresClubRepository.toDateOnly(row.drawing_date),
      state: row.state,
      cutoffTimeEt: row.cutoff_time_et,
      officialResultPostedAt: row.official_result_posted_at
        ? PostgresClubRepository.toIsoString(row.official_result_posted_at)
        : null,
      estimatedJackpot: row.estimated_jackpot == null ? null : Number(row.estimated_jackpot),
      cashValue: row.cash_value == null ? null : Number(row.cash_value),
      drawingSizeSourceUrl: row.drawing_size_source_url ?? null,
      drawingSizeSourceContentType: row.drawing_size_source_content_type ?? null,
      drawingSizeSourceDocument: row.drawing_size_source_document ?? null,
      drawingSizeSourceSha256: row.drawing_size_source_sha256 ?? null,
      drawingSizeCapturedAt: row.drawing_size_captured_at
        ? PostgresClubRepository.toIsoString(row.drawing_size_captured_at)
        : null,
      status: row.status,
      createdAt: PostgresClubRepository.toIsoString(row.created_at),
    };
  }

  private static toDrawingResult(row: Record<string, any>): DrawingResult {
    return {
      id: row.id,
      drawingId: row.drawing_id,
      clubId: row.club_id,
      officialWinningNumbers: PostgresClubRepository.toJsonValue(row.official_winning_numbers),
      jackpotEstimate: row.jackpot_estimate == null ? null : Number(row.jackpot_estimate),
      prizeBreakdown: PostgresClubRepository.toJsonValue(row.prize_breakdown),
      status: row.status,
      calculationStartedAt: row.calculation_started_at
        ? PostgresClubRepository.toIsoString(row.calculation_started_at)
        : null,
      calculatedAt: row.calculated_at ? PostgresClubRepository.toIsoString(row.calculated_at) : null,
      sourceSnapshotId: row.source_snapshot_id ?? null,
      createdAt: PostgresClubRepository.toIsoString(row.created_at),
      officialSourceUrl: row.official_source_url ?? null,
      officialSourceContentType: row.official_source_content_type ?? null,
      officialSourceDocument: row.official_source_document ?? null,
      officialSourceSha256: row.official_source_sha256 ?? null,
    };
  }

  private static toCalculationSnapshot(row: Record<string, any>): CalculationSnapshot {
    return {
      id: row.id,
      drawingId: row.drawing_id,
      clubId: row.club_id,
      lottery: row.lottery,
      rulesUrl: row.rules_url,
      rulesVersion: row.rules_version,
      priceSnapshot: PostgresClubRepository.toJsonValue(row.price_snapshot) ?? {},
      capturedAt: PostgresClubRepository.toIsoString(row.captured_at),
      sourceContentType: row.source_content_type ?? null,
      sourceDocument: row.source_document ?? null,
      sourceSha256: row.source_sha256 ?? null,
      sourceDocumentUrl: row.source_document_url ?? null,
    };
  }

  private static toPrizeAward(row: Record<string, any>): PrizeAward {
    return {
      id: row.id,
      drawingResultId: row.drawing_result_id,
      contributionId: row.contribution_id ?? null,
      userId: row.user_id ?? null,
      clubId: row.club_id,
      prizeType: row.prize_type,
      grossPrizeAmount: Number(row.gross_prize_amount),
      shareAmount: Number(row.share_amount),
      thresholdMet: row.threshold_met,
      payoutType: row.payout_type ?? null,
      status: row.status,
      createdAt: PostgresClubRepository.toIsoString(row.created_at),
      updatedAt: PostgresClubRepository.toIsoString(row.updated_at),
    };
  }

  private static toJsonValue(value: unknown): any {
    if (typeof value !== "string") {
      return value ?? null;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private static toIsoString(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private static toDateOnly(value: string | Date): string {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  }

  private static sameRules(left: CalculationSnapshot, right: CalculationSnapshot): boolean {
    return left.rulesVersion === right.rulesVersion &&
      PostgresClubRepository.stableJson(left.priceSnapshot) === PostgresClubRepository.stableJson(right.priceSnapshot);
  }

  private static sameOfficialResult(left: DrawingResult | null, right: DrawingResult): boolean {
    if (!left) {
      return right.officialWinningNumbers == null;
    }
    return PostgresClubRepository.stableJson({
      officialWinningNumbers: left.officialWinningNumbers ?? null,
      jackpotEstimate: left.jackpotEstimate ?? null,
      prizeBreakdown: left.prizeBreakdown ?? null,
    }) === PostgresClubRepository.stableJson({
      officialWinningNumbers: right.officialWinningNumbers ?? null,
      jackpotEstimate: right.jackpotEstimate ?? null,
      prizeBreakdown: right.prizeBreakdown ?? null,
    });
  }

  private static stableJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(PostgresClubRepository.stableJson).join(",")}]`;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${PostgresClubRepository.stableJson(record[key])}`);
      return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
  }
}
