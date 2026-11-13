import { randomUUID } from "node:crypto";

import type {
  Club,
  ClubMembership,
  Contribution,
  Drawing,
  DrawingResult,
  LotteryType,
  PayoutConfiguration,
  ThresholdRule,
  User,
} from "../domain";
import type { DbLikeClient } from "../services/postgres-club-repository";
import { ClubService } from "../services/club-service";
import { PostgresClubRepository } from "../services/postgres-club-repository";
import { getDrawingCountOptions, getMaxDrawings, getMaxNumberSets, getUpcomingDrawingDates, isAllowedDrawingCount } from "../services/drawing-schedule";
import type { ClubOverview, ClubMemberView, CreateClubRequest, CreateContributionInput, DrawingResultView, TicketDrawingOption, TicketNumberSetInput, UpdateClubSettingsRequest, UserClubSummary } from "./contracts";
import { ClubApiError } from "./errors";
import type { ClubApiRepository, TicketPhoto } from "./club-api-server";
import type { OidcIdentity } from "./oidc-auth";

export class PostgresClubApiRepository implements ClubApiRepository {
  constructor(private readonly client: DbLikeClient) {}

  async createClub(userId: string, input: CreateClubRequest): Promise<{ id: string }> {
    const created = await new ClubService(new PostgresClubRepository(this.client)).createClub({
      ...input,
      ownerUserId: userId,
    });
    return { id: created.club.id };
  }

  async provisionOidcUser(identity: OidcIdentity): Promise<User> {
    if (!identity.subject || !identity.email || identity.emailVerified !== true) {
      throw new ClubApiError(401, "A verified OIDC identity is required.", "invalid_identity");
    }

    const { rows: existingRows } = await this.client.query(
      "SELECT * FROM users WHERE auth_subject = $1 OR email = $2 LIMIT 1",
      [identity.subject, identity.email]
    );
    const existing = existingRows[0];
    if (existing) {
      if (existing.auth_subject && existing.auth_subject !== identity.subject) {
        throw new ClubApiError(409, "This email is already linked to another sign-in identity.", "identity_conflict");
      }
      const { rows } = await this.client.query(
        `
          UPDATE users
          SET auth_subject = $2, display_name = $3, updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [existing.id, identity.subject, identity.displayName]
      );
      return this.toUser(rows[0]);
    }

    const { rows } = await this.client.query(
      `
        INSERT INTO users (id, auth_subject, email, display_name, is_phone_verified, status)
        VALUES ($1, $2, $3, $4, false, 'active')
        RETURNING *
      `,
      [randomUUID(), identity.subject, identity.email, identity.displayName]
    );
    return this.toUser(rows[0]);
  }

  async listUserClubs(userId: string): Promise<UserClubSummary[]> {
    const { rows } = await this.client.query(
      `SELECT c.id, c.name, c.visibility, m.role
       FROM club_memberships m
       JOIN clubs c ON c.id = m.club_id
       WHERE m.user_id = $1 AND m.status = 'active' AND c.status = 'active'
       ORDER BY m.joined_at, c.name`,
      [userId]
    );
    return rows.map((row) => ({ id: row.id, name: row.name, visibility: row.visibility, role: row.role }));
  }

  async updateClubSettings(userId: string, clubId: string, input: UpdateClubSettingsRequest): Promise<Club | null> {
    const { rows: memberships } = await this.client.query(
      `SELECT m.role FROM club_memberships m
       JOIN clubs c ON c.id = m.club_id
       WHERE m.club_id = $1 AND m.user_id = $2 AND m.status = 'active' AND c.status = 'active'`,
      [clubId, userId]
    );
    if (!memberships[0]) return null;
    if (memberships[0].role !== "creator" && memberships[0].role !== "admin") {
      throw new ClubApiError(403, "Only club creators and admins may update club settings.", "club_settings_forbidden");
    }
    const { rows } = await this.client.query(
      `UPDATE clubs c
       SET name = $3, description = $4, motto = $5, visibility = $6, allow_search = $7, updated_at = NOW()
       WHERE c.id = $1 AND c.status = 'active' AND EXISTS (
         SELECT 1 FROM club_memberships m
         WHERE m.club_id = c.id AND m.user_id = $2 AND m.status = 'active' AND m.role IN ('creator', 'admin')
       )
       RETURNING c.*, c.supported_lotteries::text[] AS supported_lotteries`,
      [clubId, userId, input.name, input.description, input.motto, input.visibility, input.allowSearch]
    );
    return rows[0] ? this.toClub(rows[0]) : null;
  }

  async getClubOverview(userId: string, clubId: string): Promise<ClubOverview | null> {
    const clubRows = await this.client.query(
      "SELECT *, supported_lotteries::text[] AS supported_lotteries FROM clubs WHERE id = $1 AND status = 'active' LIMIT 1",
      [clubId]
    );
    const currentUserRows = await this.client.query(
      "SELECT * FROM users WHERE id = $1 AND status = 'active' LIMIT 1",
      [userId]
    );
    const membershipRows = await this.client.query(
      "SELECT id FROM club_memberships WHERE club_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
      [clubId, userId]
    );
    if (!clubRows.rows[0] || !currentUserRows.rows[0] || !membershipRows.rows[0]) {
      return null;
    }

    const club = this.toClub(clubRows.rows[0]);
    const payoutRows = await this.client.query("SELECT * FROM payout_configurations WHERE club_id = $1 LIMIT 1", [clubId]);
    const thresholdRows = await this.client.query("SELECT * FROM threshold_rules WHERE club_id = $1 LIMIT 1", [clubId]);
    const memberRows = await this.client.query(
        `
          SELECT m.*, u.display_name, u.email,
                 COALESCE(SUM(c.cost_usd) FILTER (WHERE c.status NOT IN ('draft', 'archived')), 0) AS contribution_total_usd,
                 COUNT(c.id) FILTER (WHERE c.status NOT IN ('draft', 'archived'))::int AS ticket_count
          FROM club_memberships m
          JOIN users u ON u.id = m.user_id
          LEFT JOIN contributions c ON c.club_id = m.club_id AND c.user_id = m.user_id
          WHERE m.club_id = $1 AND m.status = 'active'
          GROUP BY m.id, u.id
          ORDER BY m.joined_at ASC
        `,
        [clubId]
      );
    const contributionRows = await this.client.query(
      `WITH ranked_drawings AS (
         SELECT id, lottery, drawing_date, cutoff_time_et,
                ROW_NUMBER() OVER (PARTITION BY lottery ORDER BY drawing_date) AS sequence_number
         FROM drawings
       )
       SELECT c.*,
         EXISTS (SELECT 1 FROM contribution_photos p WHERE p.contribution_id = c.id) AS has_ticket_photo,
         COALESCE(c.user_id = $2 AND c.status = 'submitted' AND starts.sequence_number IS NOT NULL
           AND ((starts.drawing_date + starts.cutoff_time_et) AT TIME ZONE 'America/New_York') > NOW()
           AND NOT EXISTS (
             SELECT 1 FROM drawing_results r
             JOIN ranked_drawings target ON target.id = r.drawing_id
             WHERE r.club_id = c.club_id AND target.lottery = c.lottery
               AND target.sequence_number >= starts.sequence_number
               AND target.sequence_number < starts.sequence_number + c.drawing_count
               AND (r.status IN ('calculated', 'recalculated') OR r.official_winning_numbers IS NOT NULL AND r.official_winning_numbers <> 'null'::jsonb)
           ), false) AS can_edit
       FROM contributions c
       LEFT JOIN ranked_drawings starts ON starts.lottery = c.lottery AND starts.drawing_date = c.drawing_date
       WHERE c.club_id = $1 ORDER BY c.created_at DESC`,
      [clubId, userId]
    );
    const resultRows = await this.client.query(
        `
          WITH ranked_drawings AS (
            SELECT d.*,
                   ROW_NUMBER() OVER (PARTITION BY lottery ORDER BY drawing_date) AS sequence_number
            FROM drawings d
          ),
          relevant_drawings AS (
            SELECT d.*
            FROM ranked_drawings d
            WHERE EXISTS (
              SELECT 1
              FROM contributions c
              JOIN ranked_drawings starts
                ON starts.lottery = c.lottery AND starts.drawing_date = c.drawing_date
              WHERE c.club_id = $1
                AND c.lottery = d.lottery
                AND c.status NOT IN ('draft', 'archived')
                AND starts.sequence_number <= d.sequence_number
                AND starts.sequence_number + c.drawing_count > d.sequence_number
            )
            OR EXISTS (
              SELECT 1 FROM drawing_results existing
              WHERE existing.drawing_id = d.id AND existing.club_id = $1
            )
            OR EXISTS (
              SELECT 1 FROM clubs active_club
              WHERE active_club.id = $1
                AND active_club.status = 'active'
                AND d.lottery::text = ANY(active_club.supported_lotteries::text[])
                AND d.drawing_date >= (timezone('America/New_York', NOW()))::date
            )
          ),
          award_totals AS (
            SELECT drawing_result_id,
                   COUNT(*) FILTER (WHERE gross_prize_amount > 0)::int AS winning_ticket_count,
                   COALESCE(SUM(gross_prize_amount), 0) AS gross_prize_total
            FROM prize_awards
            GROUP BY drawing_result_id
          )
          SELECT d.*, d.drawing_date AS drawing_date,
                 r.id AS result_id,
                 r.official_winning_numbers,
                 r.jackpot_estimate AS result_jackpot_estimate,
                 r.prize_breakdown,
                 r.status AS result_status,
                 r.calculation_started_at,
                 r.calculated_at,
                 r.source_snapshot_id,
                   r.created_at AS result_created_at,
                   COALESCE(award_totals.winning_ticket_count, 0) AS winning_ticket_count,
                   COALESCE(award_totals.gross_prize_total, 0) AS gross_prize_total
          FROM relevant_drawings d
          LEFT JOIN drawing_results r ON r.drawing_id = d.id AND r.club_id = $1
                 LEFT JOIN award_totals ON award_totals.drawing_result_id = r.id
          ORDER BY d.drawing_date DESC
          LIMIT 100
        `,
        [clubId]
      );

    if (!payoutRows.rows[0] || !thresholdRows.rows[0]) {
      throw new ClubApiError(409, "Club payout settings are incomplete.", "club_configuration_incomplete");
    }

    const members: ClubMemberView[] = memberRows.rows.map((row) => ({
      ...this.toMembership(row),
      displayName: row.display_name,
      email: row.email,
      initials: this.initials(row.display_name),
      contributionTotalUsd: Number(row.contribution_total_usd),
      ticketCount: Number(row.ticket_count),
    }));
    const contributions = contributionRows.rows.map((row) => this.toContribution(row));
    const results: DrawingResultView[] = resultRows.rows.map((row) => {
      const drawing = this.toDrawing(row);
      const result: DrawingResult | null = row.result_id ? {
        id: row.result_id,
        drawingId: drawing.id,
        clubId,
        officialWinningNumbers: this.parseJson(row.official_winning_numbers),
        jackpotEstimate: row.result_jackpot_estimate == null ? null : Number(row.result_jackpot_estimate),
        prizeBreakdown: this.parseJson(row.prize_breakdown),
        status: row.result_status,
        calculationStartedAt: row.calculation_started_at ? this.toIso(row.calculation_started_at) : null,
        calculatedAt: row.calculated_at ? this.toIso(row.calculated_at) : null,
        sourceSnapshotId: row.source_snapshot_id ?? null,
        createdAt: this.toIso(row.result_created_at),
      } : null;
      return {
        drawing,
        result,
        winningTicketCount: Number(row.winning_ticket_count ?? 0),
        grossPrizeTotal: Number(row.gross_prize_total ?? 0),
      };
    });

    return {
      club,
      currentUser: this.toUser(currentUserRows.rows[0]),
      payoutConfiguration: this.toPayoutConfiguration(payoutRows.rows[0]),
      thresholdRule: this.toThresholdRule(thresholdRows.rows[0]),
      members,
      contributions,
      results,
      totalContributionsUsd: contributions
        .filter((contribution) => contribution.status !== "draft" && contribution.status !== "archived")
        .reduce((sum, contribution) => sum + contribution.costUsd, 0),
      totalGrossPrizesUsd: results.reduce((sum, item) => sum + item.grossPrizeTotal, 0),
    };
  }

  async getTicketDrawingOptions(userId: string, clubId: string): Promise<TicketDrawingOption[] | null> {
    const { rows: clubs } = await this.client.query(
      `SELECT c.supported_lotteries::text[] AS supported_lotteries
       FROM clubs c JOIN club_memberships m ON m.club_id = c.id
       WHERE c.id = $1 AND c.status = 'active' AND m.user_id = $2 AND m.status = 'active'`,
      [clubId, userId]
    );
    if (!clubs[0]) return null;

    const { rows } = await this.client.query(
      `SELECT d.lottery, d.drawing_date,
        COUNT(*) OVER (PARTITION BY d.lottery ORDER BY d.drawing_date DESC) AS available_count,
        (SELECT s.price_snapshot FROM calculation_snapshots s
        JOIN drawings source_drawing ON source_drawing.id = s.drawing_id
        WHERE s.club_id = $1 AND source_drawing.lottery = d.lottery
         ORDER BY s.captured_at DESC LIMIT 1) AS price_snapshot
       FROM drawings d
       WHERE d.lottery::text = ANY($2::text[])
         AND d.drawing_date >= (timezone('America/New_York', NOW()))::date
       ORDER BY d.lottery, d.drawing_date`,
      [clubId, clubs[0].supported_lotteries]
    );
    return rows.map((row) => {
      const snapshot = this.parseJson(row.price_snapshot);
      const price = Number(snapshot?.ticketPrice);
      const sourceRules = snapshot?.numberRules;
      const rules = sourceRules && {
        mainNumberCount: Number(sourceRules.mainNumberCount),
        mainNumberMin: Number(sourceRules.mainNumberMin),
        mainNumberMax: Number(sourceRules.mainNumberMax),
        bonusNumberMin: Number(sourceRules.bonusNumberMin),
        bonusNumberMax: Number(sourceRules.bonusNumberMax),
      };
      return {
        lottery: row.lottery,
        drawingDate: this.dateOnly(row.drawing_date),
        maxDrawingCount: Math.min(getMaxDrawings(row.lottery), Number(row.available_count)),
        drawingCountOptions: getDrawingCountOptions(row.lottery, Number(row.available_count)),
        maxNumberSets: getMaxNumberSets(row.lottery),
        ticketPrice: Number.isFinite(price) && price > 0 ? price : null,
        numberRules: rules && Object.values(rules).every(Number.isInteger) ? rules : null,
      };
    });
  }

  async ensureUpcomingDrawings(userId: string, clubId: string, asOfDate?: string): Promise<Drawing[] | null> {
    const { rows: clubs } = await this.client.query(
      `SELECT c.supported_lotteries::text[] AS supported_lotteries
       FROM clubs c JOIN club_memberships m ON m.club_id = c.id
       WHERE c.id = $1 AND c.status = 'active' AND m.user_id = $2 AND m.status = 'active'`,
      [clubId, userId]
    );
    if (!clubs[0]) return null;

    const scheduleDate = asOfDate ?? this.getEasternDate();
    const supportedLotteries = clubs[0].supported_lotteries as LotteryType[];
    const schedule = supportedLotteries.flatMap((lottery) =>
      getUpcomingDrawingDates([lottery], scheduleDate, getMaxDrawings(lottery), 120)
    );
    if (!schedule.length) return [];
    const now = new Date().toISOString();
    const insertValues: unknown[] = [];
    const insertRows = schedule.map((drawing, index) => {
      const offset = index * 5;
      insertValues.push(randomUUID(), drawing.lottery, drawing.drawingDate, drawing.cutoffTimeEt, now);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, 'MI', $${offset + 4}, 'pending', $${offset + 5})`;
    });
    await this.client.query(
      `INSERT INTO drawings (id, lottery, drawing_date, state, cutoff_time_et, status, created_at)
       VALUES ${insertRows.join(", ")}
       ON CONFLICT (lottery, drawing_date) DO NOTHING`,
      insertValues
    );
    const scheduleValues: unknown[] = [];
    const schedulePairs = schedule.map((drawing, index) => {
      const offset = index * 2;
      scheduleValues.push(drawing.lottery, drawing.drawingDate);
      return `($${offset + 1}::text, $${offset + 2}::date)`;
    });
    const { rows } = await this.client.query(
      `SELECT * FROM drawings
       WHERE (lottery::text, drawing_date) IN (VALUES ${schedulePairs.join(", ")})
       ORDER BY drawing_date, lottery`,
      scheduleValues
    );
    return rows.map((row) => this.toDrawing(row));
  }

  async createContribution(userId: string, clubId: string, input: CreateContributionInput, photo?: TicketPhoto): Promise<Contribution> {
    if (!isAllowedDrawingCount(input.lottery, input.drawingCount)) {
      throw new ClubApiError(400, "The selected number of drawings is not available for this lottery.", "invalid_drawing_count");
    }
    const { rows: clubs } = await this.client.query(
      "SELECT id, status, supported_lotteries::text[] AS supported_lotteries FROM clubs WHERE id = $1 LIMIT 1",
      [clubId]
    );
    const club = clubs[0];
    if (!club || club.status !== "active") {
      throw new ClubApiError(404, "Active club not found.", "club_not_found");
    }
    if (!club.supported_lotteries.includes(input.lottery)) {
      throw new ClubApiError(400, "This club does not support the selected lottery.", "unsupported_lottery");
    }

    const { rows: memberships } = await this.client.query(
      "SELECT id FROM club_memberships WHERE club_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
      [clubId, userId]
    );
    if (!memberships[0]) {
      throw new ClubApiError(404, "Active club membership not found.", "membership_not_found");
    }

    const { rows: drawings } = await this.client.query(
      `
        SELECT id, drawing_date
        FROM drawings
        WHERE lottery = $1 AND drawing_date >= $2::date
        ORDER BY drawing_date ASC
        LIMIT $3
      `,
      [input.lottery, input.drawingDate, input.drawingCount]
    );
    if (drawings.length !== input.drawingCount || this.dateOnly(drawings[0]?.drawing_date) !== input.drawingDate) {
      throw new ClubApiError(409, "The selected drawing schedule is incomplete or no longer available.", "drawing_unavailable");
    }

    const { rows: snapshots } = await this.client.query(
      `
        SELECT s.price_snapshot
        FROM calculation_snapshots s
        JOIN drawings source_drawing ON source_drawing.id = s.drawing_id
        WHERE source_drawing.lottery = $2 AND s.club_id = $1
        ORDER BY s.captured_at DESC LIMIT 1
      `,
      [clubId, input.lottery]
    );
    if (!snapshots[0]) {
      throw new ClubApiError(409, "Official ticket pricing is not available for this drawing yet.", "pricing_unavailable");
    }
    const snapshot = this.parseJson(snapshots[0].price_snapshot);
    const price = Number(snapshot?.ticketPrice);
    const numberRules = snapshot?.numberRules;
    const plays = input.numberSets ?? [{ numbers: input.numbers!, bonusNumber: input.bonusNumber! }];
    if (!plays.length || plays.length > getMaxNumberSets(input.lottery) || !Number.isFinite(price) || price <= 0 || plays.some((play) => !this.validNumberSet(play, numberRules))) {
      throw new ClubApiError(400, "The ticket does not match the saved official game rules.", "invalid_number_set");
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const numberSets = plays.map((play) => ({
      id: randomUUID(),
      contributionId: id,
      numbers: play.numbers,
      bonusNumber: String(play.bonusNumber),
      createdAt,
    }));
    const { rows } = await this.client.query(
      `
        WITH inserted AS (INSERT INTO contributions (
          id, club_id, user_id, lottery, drawing_date, drawing_count,
          number_sets, cost_usd, status, created_at, updated_at, version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'submitted', $9, $9, 1)
        RETURNING *),
        saved_photo AS (
          INSERT INTO contribution_photos (contribution_id, data, content_type)
          SELECT id, $10::bytea, $11::text FROM inserted WHERE $10::bytea IS NOT NULL
        )
        SELECT inserted.*, ($10::bytea IS NOT NULL) AS has_ticket_photo FROM inserted
      `,
      [id, clubId, userId, input.lottery, input.drawingDate, input.drawingCount, JSON.stringify(numberSets), price * input.drawingCount * plays.length, createdAt, photo?.data ?? null, photo?.contentType ?? null]
    );
    return this.toContribution(rows[0]);
  }

  async updateContribution(userId: string, clubId: string, contributionId: string, input: CreateContributionInput): Promise<Contribution> {
    if (!isAllowedDrawingCount(input.lottery, input.drawingCount)) {
      throw new ClubApiError(400, "The selected number of drawings is not available for this lottery.", "invalid_drawing_count");
    }
    const { rows: currentRows } = await this.client.query(
      `SELECT c.*, ((d.drawing_date + d.cutoff_time_et) AT TIME ZONE 'America/New_York') > NOW() AS before_cutoff,
              club.supported_lotteries::text[] AS supported_lotteries
       FROM contributions c
       JOIN clubs club ON club.id = c.club_id AND club.status = 'active'
       JOIN club_memberships m ON m.club_id = c.club_id AND m.user_id = $1 AND m.status = 'active'
       JOIN drawings d ON d.lottery = c.lottery AND d.drawing_date = c.drawing_date
       WHERE c.id = $2 AND c.club_id = $3 AND c.user_id = $1
       LIMIT 1`,
      [userId, contributionId, clubId]
    );
    const current = currentRows[0];
    if (!current) throw new ClubApiError(404, "Ticket was not found or is not owned by this member.", "contribution_not_found");
    if (current.status !== "submitted" || current.before_cutoff !== true) {
      throw new ClubApiError(409, "Tickets can only be edited before the first drawing cutoff.", "contribution_not_editable");
    }
    if (!current.supported_lotteries.includes(input.lottery)) {
      throw new ClubApiError(400, "This club does not support the selected lottery.", "unsupported_lottery");
    }

    const { rows: drawings } = await this.client.query(
      `SELECT id, drawing_date FROM drawings
       WHERE lottery = $1 AND drawing_date >= $2::date
       ORDER BY drawing_date ASC LIMIT $3`,
      [input.lottery, input.drawingDate, input.drawingCount]
    );
    if (drawings.length !== input.drawingCount || this.dateOnly(drawings[0]?.drawing_date) !== input.drawingDate) {
      throw new ClubApiError(409, "The selected drawing schedule is incomplete or no longer available.", "drawing_unavailable");
    }
    const targetIds = drawings.map((drawing) => drawing.id);
    const { rows: oldDrawings } = await this.client.query(
      `SELECT id FROM drawings WHERE lottery = $1 AND drawing_date >= $2::date
       ORDER BY drawing_date ASC LIMIT $3`,
      [current.lottery, this.dateOnly(current.drawing_date), Number(current.drawing_count)]
    );
    const affectedDrawingIds = [...new Set([...targetIds, ...oldDrawings.map((drawing) => drawing.id)])];
    const { rows: existingResults } = await this.client.query(
      "SELECT id FROM drawing_results WHERE club_id = $1 AND drawing_id = ANY($2::uuid[]) AND (status IN ('calculated', 'recalculated') OR official_winning_numbers IS NOT NULL AND official_winning_numbers <> 'null'::jsonb) LIMIT 1",
      [clubId, affectedDrawingIds]
    );
    if (existingResults.length) {
      throw new ClubApiError(409, "Tickets with posted results require recalculation support before they can be edited.", "recalculation_required");
    }

    const { rows: snapshots } = await this.client.query(
      `SELECT s.price_snapshot FROM calculation_snapshots s
       JOIN drawings source_drawing ON source_drawing.id = s.drawing_id
       WHERE s.club_id = $1 AND source_drawing.lottery = $2
       ORDER BY s.captured_at DESC LIMIT 1`,
      [clubId, input.lottery]
    );
    if (!snapshots[0]) throw new ClubApiError(409, "Official ticket pricing is not available for this drawing yet.", "pricing_unavailable");
    const snapshot = this.parseJson(snapshots[0].price_snapshot);
    const price = Number(snapshot?.ticketPrice);
    const rules = snapshot?.numberRules;
    const plays = input.numberSets ?? [{ numbers: input.numbers!, bonusNumber: input.bonusNumber! }];
    if (!Number.isFinite(price) || price <= 0 || !plays.length || plays.length > getMaxNumberSets(input.lottery) || plays.some((play) => !this.validNumberSet(play, rules))) {
      throw new ClubApiError(400, "The ticket does not match the saved official game rules.", "invalid_number_set");
    }

    const now = new Date().toISOString();
    const numberSets = plays.map((play) => ({
      id: randomUUID(),
      contributionId,
      numbers: play.numbers,
      bonusNumber: String(play.bonusNumber),
      createdAt: now,
    }));
    const { rows } = await this.client.query(
      `WITH existing AS MATERIALIZED (
         SELECT c.* FROM contributions c
         JOIN club_memberships m ON m.club_id = c.club_id AND m.user_id = $1 AND m.status = 'active'
         WHERE c.id = $2 AND c.club_id = $3 AND c.user_id = $1 AND c.status = 'submitted' AND c.version = $10
           AND NOT EXISTS (
             SELECT 1 FROM drawing_results r
             WHERE r.club_id = $3 AND r.drawing_id = ANY($11::uuid[])
               AND (r.status IN ('calculated', 'recalculated') OR r.official_winning_numbers IS NOT NULL AND r.official_winning_numbers <> 'null'::jsonb)
           )
           AND EXISTS (
             SELECT 1 FROM drawings original
             WHERE original.lottery = c.lottery AND original.drawing_date = c.drawing_date
               AND ((original.drawing_date + original.cutoff_time_et) AT TIME ZONE 'America/New_York') > NOW()
           )
           AND EXISTS (
             SELECT 1 FROM drawings d WHERE d.lottery = $4 AND d.drawing_date = $5::date
               AND ((d.drawing_date + d.cutoff_time_et) AT TIME ZONE 'America/New_York') > NOW()
           )
         FOR UPDATE OF c
       ), updated AS (
         UPDATE contributions c
         SET lottery = $4, drawing_date = $5, drawing_count = $6, number_sets = $7::jsonb,
             cost_usd = $8, updated_at = $9, version = c.version + 1
         FROM existing e
         WHERE c.id = e.id AND c.version = $10
         RETURNING c.*
       ), audit AS (
         INSERT INTO audit_events (club_id, actor_user_id, entity_type, entity_id, action, old_value, new_value, occurred_at)
         SELECT $3, $1, 'contribution', u.id, 'updated',
           jsonb_build_object('lottery', e.lottery, 'drawingDate', e.drawing_date, 'drawingCount', e.drawing_count, 'numberSets', e.number_sets, 'costUsd', e.cost_usd),
           jsonb_build_object('lottery', u.lottery, 'drawingDate', u.drawing_date, 'drawingCount', u.drawing_count, 'numberSets', u.number_sets, 'costUsd', u.cost_usd), $9
         FROM existing e JOIN updated u ON u.id = e.id
         RETURNING entity_id
       )
       SELECT u.*, EXISTS (SELECT 1 FROM contribution_photos p WHERE p.contribution_id = u.id) AS has_ticket_photo
       FROM updated u JOIN audit a ON a.entity_id = u.id`,
      [userId, contributionId, clubId, input.lottery, input.drawingDate, input.drawingCount, JSON.stringify(numberSets), price * input.drawingCount * plays.length, now, Number(current.version), affectedDrawingIds]
    );
    if (!rows[0]) throw new ClubApiError(409, "The ticket changed or is no longer editable.", "contribution_not_editable");
    return this.toContribution(rows[0]);
  }

  async getContributionPhoto(userId: string, clubId: string, contributionId: string): Promise<TicketPhoto | null> {
    const { rows } = await this.client.query(
      `SELECT p.data, p.content_type FROM contribution_photos p
       JOIN contributions c ON c.id = p.contribution_id
       JOIN clubs club ON club.id = c.club_id AND club.status = 'active'
       JOIN club_memberships m ON m.club_id = club.id AND m.user_id = $1 AND m.status = 'active'
       WHERE club.id = $2 AND c.id = $3`,
      [userId, clubId, contributionId]
    );
    return rows[0] ? { data: rows[0].data, contentType: rows[0].content_type } : null;
  }

  private validNumberSet(input: TicketNumberSetInput, rules: Record<string, unknown> | null | undefined): boolean {
    if (!rules) return false;
    const count = Number(rules.mainNumberCount);
    const mainMin = Number(rules.mainNumberMin);
    const mainMax = Number(rules.mainNumberMax);
    const bonusMin = Number(rules.bonusNumberMin);
    const bonusMax = Number(rules.bonusNumberMax);
    return Number.isInteger(count) && count === input.numbers.length &&
      Number.isInteger(mainMin) && Number.isInteger(mainMax) &&
      Number.isInteger(bonusMin) && Number.isInteger(bonusMax) &&
      input.numbers.every((number) => Number.isInteger(number) && number >= mainMin && number <= mainMax) &&
      new Set(input.numbers).size === input.numbers.length &&
      Number.isInteger(input.bonusNumber) && input.bonusNumber >= bonusMin && input.bonusNumber <= bonusMax;
  }

  private getEasternDate(): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  private toUser(row: Record<string, any>): User {
    return {
      id: row.id,
      authSubject: row.auth_subject ?? null,
      email: row.email,
      displayName: row.display_name,
      phoneNumber: row.phone_number ?? null,
      isPhoneVerified: row.is_phone_verified,
      status: row.status,
      createdAt: this.toIso(row.created_at),
      updatedAt: this.toIso(row.updated_at),
      closedAt: row.closed_at ? this.toIso(row.closed_at) : null,
    };
  }

  private toClub(row: Record<string, any>): Club {
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
      supportedLotteries: row.supported_lotteries,
      allowSearch: row.allow_search,
      createdAt: this.toIso(row.created_at),
      updatedAt: this.toIso(row.updated_at),
      closedAt: row.closed_at ? this.toIso(row.closed_at) : null,
    };
  }

  private toMembership(row: Record<string, any>): ClubMembership {
    return {
      id: row.id,
      clubId: row.club_id,
      userId: row.user_id,
      role: row.role,
      status: row.status,
      joinedAt: this.toIso(row.joined_at),
      approvedAt: row.approved_at ? this.toIso(row.approved_at) : null,
      removedAt: row.removed_at ? this.toIso(row.removed_at) : null,
      removedByUserId: row.removed_by_user_id ?? null,
      createdAt: this.toIso(row.created_at),
      updatedAt: this.toIso(row.updated_at),
    };
  }

  private toContribution(row: Record<string, any>): Contribution {
    return {
      id: row.id,
      clubId: row.club_id,
      userId: row.user_id,
      lottery: row.lottery,
      drawingDate: this.dateOnly(row.drawing_date),
      drawingCount: Number(row.drawing_count),
      numberSets: this.parseJson(row.number_sets) ?? [],
      ticketImageUrl: row.ticket_image_url ?? null,
      hasTicketPhoto: Boolean(row.has_ticket_photo),
      canEdit: Boolean(row.can_edit),
      costUsd: Number(row.cost_usd),
      status: row.status,
      createdAt: this.toIso(row.created_at),
      updatedAt: this.toIso(row.updated_at),
      version: Number(row.version),
    };
  }

  private toDrawing(row: Record<string, any>): Drawing {
    return {
      id: row.id,
      lottery: row.lottery,
      drawingDate: this.dateOnly(row.drawing_date),
      state: row.state,
      cutoffTimeEt: row.cutoff_time_et,
      officialResultPostedAt: row.official_result_posted_at ? this.toIso(row.official_result_posted_at) : null,
      estimatedJackpot: row.estimated_jackpot == null ? null : Number(row.estimated_jackpot),
      cashValue: row.cash_value == null ? null : Number(row.cash_value),
      drawingSizeSourceUrl: row.drawing_size_source_url ?? null,
      drawingSizeSourceContentType: row.drawing_size_source_content_type ?? null,
      drawingSizeSourceDocument: row.drawing_size_source_document ?? null,
      drawingSizeSourceSha256: row.drawing_size_source_sha256 ?? null,
      drawingSizeCapturedAt: row.drawing_size_captured_at ? this.toIso(row.drawing_size_captured_at) : null,
      status: row.status,
      createdAt: this.toIso(row.created_at),
    };
  }

  private toPayoutConfiguration(row: Record<string, any>): PayoutConfiguration {
    return { id: row.id, clubId: row.club_id, type: row.type, version: Number(row.version), createdAt: this.toIso(row.created_at) };
  }

  private toThresholdRule(row: Record<string, any>): ThresholdRule {
    return {
      id: row.id,
      clubId: row.club_id,
      thresholdAmount: Number(row.threshold_amount),
      method: row.method,
      createdAt: this.toIso(row.created_at),
    };
  }

  private parseJson(value: unknown): any {
    if (typeof value !== "string") return value ?? null;
    try { return JSON.parse(value); } catch { return null; }
  }

  private dateOnly(value: string | Date): string {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  }

  private toIso(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private initials(displayName: string): string {
    return displayName.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
  }
}
