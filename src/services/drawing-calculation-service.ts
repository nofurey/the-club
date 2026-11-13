import { randomUUID } from "node:crypto";

import type {
  CalculationSnapshot,
  Club,
  ClubMembership,
  Contribution,
  Drawing,
  DrawingResult,
  LotteryType,
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
  findCalculationSnapshotById(snapshotId: string): Promise<CalculationSnapshot | null>;
  findMembershipsByClub(clubId: string): Promise<ClubMembership[]>;
  findContributionsForClub(clubId: string): Promise<Contribution[]>;
  findPayoutConfigurationByClub(clubId: string): Promise<PayoutConfiguration | null>;
  findThresholdRuleByClub(clubId: string): Promise<ThresholdRule | null>;
  replacePrizeAwardsAndCompleteResult(
    resultId: string,
    awards: PrizeAward[],
    status: "calculated" | "recalculated",
    calculatedAt: string
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

    const persistedAwards = await this.repository.replacePrizeAwardsAndCompleteResult(
      result.id,
      awards,
      resultStatus,
      now
    );

    return {
      result: { ...result, status: resultStatus, calculationStartedAt: result.calculationStartedAt ?? now, calculatedAt: now },
      awards: persistedAwards,
      eligibleMemberIds,
      totalPrize: payout.totalPrize,
    };
  }
}
