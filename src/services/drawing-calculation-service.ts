import { randomUUID } from "node:crypto";

import type {
  CalculationSnapshot,
  Club,
  ClubMembership,
  Contribution,
  Drawing,
  DrawingResult,
  LotteryType,
  NotificationDraft,
  PayoutConfiguration,
  PrizeAward,
  ThresholdRule,
} from "../domain";
import { PayoutService } from "./payout-service";

export interface EvaluatedPrize {
  contributionId: string;
  userId: string;
  prizeType: string;
  amount: number;
}

export interface DrawingEvaluation {
  drawingContributionIds: string[];
  wins: EvaluatedPrize[];
}

export interface DrawingPrizeEvaluator {
  evaluate(input: {
    drawing: Drawing;
    drawings: Drawing[];
    result: DrawingResult;
    snapshot: CalculationSnapshot;
    contributions: Contribution[];
  }): Promise<DrawingEvaluation>;
}

export interface DrawingCalculationRepository {
  findClubById(clubId: string): Promise<Club | null>;
  findDrawingById(drawingId: string): Promise<Drawing | null>;
  findDrawingsByLottery(lottery: LotteryType): Promise<Drawing[]>;
  findDrawingResultByDrawingAndClub(drawingId: string, clubId: string): Promise<DrawingResult | null>;
  findPrizeAwardsForResult(resultId: string): Promise<PrizeAward[]>;
  findCalculationSnapshotById(snapshotId: string): Promise<CalculationSnapshot | null>;
  findMembershipsByClub(clubId: string): Promise<ClubMembership[]>;
  findContributionsForClub(clubId: string): Promise<Contribution[]>;
  findPayoutConfigurationByClub(clubId: string): Promise<PayoutConfiguration | null>;
  findThresholdRuleByClub(clubId: string): Promise<ThresholdRule | null>;
  replacePrizeAwardsAndCompleteResult(
    resultId: string,
    awards: PrizeAward[],
    status: "calculated" | "recalculated",
    calculatedAt: string,
    notifications?: NotificationDraft[]
  ): Promise<PrizeAward[]>;
}

export interface CalculateDrawingInput {
  drawingId: string;
  clubId: string;
  cutoffAt: string;
  recalculation?: boolean;
}

export interface CalculateDrawingResult {
  result: DrawingResult;
  awards: PrizeAward[];
  eligibleMemberIds: string[];
  totalPrize: number;
}

export class DrawingCalculationService {
  constructor(
    private readonly repository: DrawingCalculationRepository,
    private readonly evaluator: DrawingPrizeEvaluator,
    private readonly payoutService = new PayoutService()
  ) {}

  async calculateDrawing({ drawingId, clubId, cutoffAt, recalculation = false }: CalculateDrawingInput): Promise<CalculateDrawingResult> {
    const cutoffTime = Date.parse(cutoffAt);
    if (!Number.isFinite(cutoffTime)) {
      throw new Error("A valid drawing cutoff timestamp is required.");
    }

    const club = await this.repository.findClubById(clubId);
    const drawing = await this.repository.findDrawingById(drawingId);
    const result = await this.repository.findDrawingResultByDrawingAndClub(drawingId, clubId);
    const memberships = await this.repository.findMembershipsByClub(clubId);
    const contributions = await this.repository.findContributionsForClub(clubId);
    const payoutConfiguration = await this.repository.findPayoutConfigurationByClub(clubId);
    const thresholdRule = await this.repository.findThresholdRuleByClub(clubId);

    if (!club) {
      throw new Error("Club not found.");
    }
    if (!drawing) {
      throw new Error("Drawing not found.");
    }
    if (!club.supportedLotteries.includes(drawing.lottery)) {
      throw new Error("Club does not support this drawing's lottery.");
    }
    if (!result || result.drawingId !== drawingId || result.clubId !== clubId) {
      throw new Error("Posted drawing results were not found for this club.");
    }
    if (!result.officialWinningNumbers) {
      throw new Error("Official winning numbers are required before calculation.");
    }
    if (result.status === "pending") {
      throw new Error("Drawing results must be posted before calculation.");
    }
    const previousAwards = await this.repository.findPrizeAwardsForResult(result.id);
    if (!result.sourceSnapshotId) {
      throw new Error("A calculation rules snapshot is required.");
    }
    if (!payoutConfiguration || !thresholdRule) {
      throw new Error("Club payout configuration or threshold rule is missing.");
    }

    const snapshot = await this.repository.findCalculationSnapshotById(result.sourceSnapshotId);
    if (
      !snapshot ||
      snapshot.drawingId !== drawingId ||
      snapshot.clubId !== clubId ||
      snapshot.lottery !== drawing.lottery
    ) {
      throw new Error("The drawing's rules snapshot was not found.");
    }

    const clubContributions = contributions.filter((contribution) => contribution.clubId === clubId);
  const drawings = await this.repository.findDrawingsByLottery(drawing.lottery);
  const evaluation = await this.evaluator.evaluate({ drawing, drawings, result, snapshot, contributions: clubContributions });
    const contributionById = new Map(clubContributions.map((contribution) => [contribution.id, contribution]));
    const drawingContributionIds = [...new Set(evaluation.drawingContributionIds)];

    for (const contributionId of drawingContributionIds) {
      if (!contributionById.has(contributionId)) {
        throw new Error("Drawing evaluator returned a contribution outside the club.");
      }
    }

    const eligibleMemberIds = this.payoutService.getEligibleMembersForDrawing({
      memberships,
      drawingDate: drawing.drawingDate,
      cutoffAt,
    });
    const eligibleMembers = new Set(eligibleMemberIds);
    const wins = evaluation.wins.map((win) => {
      const contribution = contributionById.get(win.contributionId);
      if (!contribution || contribution.userId !== win.userId) {
        throw new Error("Drawing evaluator returned a win that does not match its contribution.");
      }
      if (!drawingContributionIds.includes(win.contributionId)) {
        throw new Error("Drawing evaluator returned a win for a contribution outside this drawing.");
      }
      if (!Number.isFinite(win.amount) || win.amount < 0 || !win.prizeType.trim()) {
        throw new Error("Drawing evaluator returned an invalid prize.");
      }
      return win;
    }).filter((win) => eligibleMembers.has(win.userId));

    const payout = this.payoutService.calculatePayout({
      eligibleMemberIds,
      contributions: clubContributions,
      drawingContributionIds,
      prizeValues: wins.map(({ userId, amount }) => ({ userId, amount })),
      thresholdRule,
      payoutConfiguration,
    });

    const grossByUser = new Map<string, number>();
    for (const win of wins) {
      grossByUser.set(win.userId, (grossByUser.get(win.userId) ?? 0) + win.amount);
    }

    const now = new Date().toISOString();
    const isRecalculation = recalculation || result.status === "calculated" || result.status === "recalculated";
    const resultStatus = isRecalculation ? "recalculated" : "calculated";
    const awards = payout.allocations
      .filter((allocation) => allocation.amount > 0 || (grossByUser.get(allocation.userId) ?? 0) > 0)
      .map((allocation): PrizeAward => ({
        id: randomUUID(),
        drawingResultId: result.id,
        contributionId: null,
        userId: allocation.userId,
        clubId,
        prizeType: "drawing_payout",
        grossPrizeAmount: Number((grossByUser.get(allocation.userId) ?? 0).toFixed(2)),
        shareAmount: allocation.amount,
        thresholdMet: allocation.thresholdMet,
        payoutType: payoutConfiguration.type,
        status: isRecalculation ? "recalculated" : "allocated",
        createdAt: now,
        updatedAt: now,
      }));

    const notificationDrafts = this.createNotificationDrafts({
      club,
      drawing,
      previousAwards,
      awards,
      eligibleMemberIds,
      drawingContributionIds,
      contributions: clubContributions,
      grossByUser,
      shareByUser: new Map(payout.allocations.map((allocation) => [allocation.userId, allocation.amount])),
      payoutType: payoutConfiguration.type,
      totalPrize: payout.totalPrize,
      thresholdMet: payout.thresholdMet,
      recalculation: isRecalculation,
    });
    const persistedAwards = await this.repository.replacePrizeAwardsAndCompleteResult(
      result.id,
      awards,
      resultStatus,
      now,
      notificationDrafts
    );

    return {
      result: { ...result, status: resultStatus, calculationStartedAt: result.calculationStartedAt ?? now, calculatedAt: now },
      awards: persistedAwards,
      eligibleMemberIds,
      totalPrize: payout.totalPrize,
    };
  }

  private createNotificationDrafts({
    club,
    drawing,
    previousAwards,
    awards,
    eligibleMemberIds,
    drawingContributionIds,
    contributions,
    grossByUser,
    shareByUser,
    payoutType,
    totalPrize,
    thresholdMet,
    recalculation,
  }: {
    club: Club;
    drawing: Drawing;
    previousAwards: PrizeAward[];
    awards: PrizeAward[];
    eligibleMemberIds: string[];
    drawingContributionIds: string[];
    contributions: Contribution[];
    grossByUser: Map<string, number>;
    shareByUser: Map<string, number>;
    payoutType: PayoutConfiguration["type"];
    totalPrize: number;
    thresholdMet: boolean;
    recalculation: boolean;
  }): NotificationDraft[] {
    const context = `${drawing.lottery === "powerball" ? "Powerball" : "Mega Millions"} drawing on ${drawing.drawingDate}`;
    if (!recalculation) {
      if (totalPrize <= 0) return [];
      const eligibleSet = new Set(eligibleMemberIds);
      const drawingEntries = new Set(drawingContributionIds);
      const recipients = !thresholdMet
        ? [...grossByUser.keys()]
        : payoutType === "proportion_drawing_specific"
          ? contributions.filter((contribution) => drawingEntries.has(contribution.id) && eligibleSet.has(contribution.userId)).map((contribution) => contribution.userId)
          : eligibleMemberIds;
      return [...new Set(recipients)].map((userId) => ({
        userId,
        clubId: club.id,
        drawingId: drawing.id,
        type: "payout_calculated",
        message: `${club.name}: ${context} is calculated. Gross prize: ${this.formatMoney(grossByUser.get(userId) ?? 0)}; your recorded share: ${this.formatMoney(shareByUser.get(userId) ?? 0)}.`,
      }));
    }

    const previousByUser = this.sumAwardsByUser(previousAwards);
    const currentByUser = this.sumAwardsByUser(awards);
    const userIds = new Set([...previousByUser.keys(), ...currentByUser.keys()]);
    const notifications: NotificationDraft[] = [];
    for (const userId of userIds) {
      const previous = previousByUser.get(userId);
      const current = currentByUser.get(userId);
      let recalculationType: string;
      let message: string;
      if (!previous && current) {
        recalculationType = "win_added";
        message = `${club.name}: a recalculation added a payout for the ${context}. Your recorded share is ${this.formatMoney(current.share)}.`;
      } else if (previous && !current) {
        recalculationType = "win_removed";
        message = `${club.name}: a recalculation removed your recorded payout for the ${context}. The previous share was ${this.formatMoney(previous.share)}.`;
      } else if (previous && current && (previous.gross !== current.gross || previous.share !== current.share)) {
        recalculationType = "win_updated";
        message = `${club.name}: a recalculation changed your payout for the ${context}. Your new recorded share is ${this.formatMoney(current.share)}.`;
      } else {
        continue;
      }
      notifications.push({
        userId,
        clubId: club.id,
        drawingId: drawing.id,
        type: "payout_recalculated",
        recalculationType,
        message,
      });
    }
    return notifications;
  }

  private sumAwardsByUser(awards: PrizeAward[]): Map<string, { gross: number; share: number }> {
    const totals = new Map<string, { gross: number; share: number }>();
    for (const award of awards) {
      if (!award.userId) continue;
      const total = totals.get(award.userId) ?? { gross: 0, share: 0 };
      total.gross += award.grossPrizeAmount;
      total.share += award.shareAmount;
      totals.set(award.userId, total);
    }
    return totals;
  }

  private formatMoney(amount: number): string {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  }
}
