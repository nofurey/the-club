import assert from "node:assert/strict";
import test from "node:test";

import type {
  CalculationSnapshot,
  Club,
  ClubMembership,
  Contribution,
  Drawing,
  DrawingResult,
  PayoutConfiguration,
  PrizeAward,
  ThresholdRule,
} from "../domain";
import {
  DrawingCalculationService,
  type DrawingCalculationRepository,
} from "./drawing-calculation-service";
import { SnapshotLotteryPrizeEvaluator } from "./lottery-prize-evaluator";

const club: Club = {
  id: "club-1",
  name: "Test Club",
  description: null,
  motto: null,
  visibility: "public",
  ownerUserId: "u1",
  status: "active",
  payoutConfigurationId: "pc-1",
  thresholdRuleId: "tr-1",
  supportedLotteries: ["powerball"],
  allowSearch: true,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  closedAt: null,
};

const drawing: Drawing = {
  id: "drawing-1",
  lottery: "powerball",
  drawingDate: "2025-01-05",
  state: "MI",
  cutoffTimeEt: "21:58:00",
  officialResultPostedAt: "2025-01-05T22:30:00.000Z",
  status: "results_posted",
  createdAt: "2025-01-01T00:00:00.000Z",
};

const result: DrawingResult = {
  id: "result-1",
  drawingId: drawing.id,
  clubId: club.id,
  officialWinningNumbers: { numbers: [1, 2, 3, 4, 5], bonusNumber: "6" },
  jackpotEstimate: 1000000,
  prizeBreakdown: {},
  status: "results_posted",
  calculationStartedAt: null,
  calculatedAt: null,
  sourceSnapshotId: "snapshot-1",
  createdAt: "2025-01-05T22:30:00.000Z",
};

const snapshot: CalculationSnapshot = {
  id: "snapshot-1",
  drawingId: drawing.id,
  clubId: club.id,
  lottery: "powerball",
  rulesUrl: "https://example.test/powerball-rules",
  rulesVersion: "2025-01",
  priceSnapshot: {
    numberRules: {
      mainNumberCount: 5,
      mainNumberMin: 1,
      mainNumberMax: 69,
      bonusNumberMin: 1,
      bonusNumberMax: 26,
    },
    prizeTiers: [{ mainMatches: 5, bonusMatches: true, prizeType: "jackpot", prizeAmount: "jackpot_estimate" }],
  },
  capturedAt: "2025-01-05T22:30:00.000Z",
};

const memberships: ClubMembership[] = [
  {
    id: "m1",
    clubId: club.id,
    userId: "u1",
    role: "creator",
    status: "active",
    joinedAt: "2025-01-01T00:00:00.000Z",
    approvedAt: "2025-01-01T00:00:00.000Z",
    removedAt: null,
    removedByUserId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "m2",
    clubId: club.id,
    userId: "u2",
    role: "member",
    status: "active",
    joinedAt: "2025-01-06T04:00:00.000Z",
    approvedAt: "2025-01-06T04:00:00.000Z",
    removedAt: null,
    removedByUserId: null,
    createdAt: "2025-01-06T04:00:00.000Z",
    updatedAt: "2025-01-06T04:00:00.000Z",
  },
];

const contributions: Contribution[] = [
  {
    id: "contribution-1",
    clubId: club.id,
    userId: "u1",
    lottery: "powerball",
    drawingDate: drawing.drawingDate,
    drawingCount: 1,
    numberSets: [{ numbers: [1, 2, 3, 4, 5], bonusNumber: "6" }],
    costUsd: 2,
    status: "submitted",
    createdAt: "2025-01-05T20:00:00.000Z",
    updatedAt: "2025-01-05T20:00:00.000Z",
    version: 1,
  },
  {
    id: "contribution-2",
    clubId: club.id,
    userId: "u2",
    lottery: "powerball",
    drawingDate: drawing.drawingDate,
    drawingCount: 1,
    numberSets: [{ numbers: [7, 8, 9, 10, 11], bonusNumber: "12" }],
    costUsd: 2,
    status: "submitted",
    createdAt: "2025-01-05T22:01:00.000Z",
    updatedAt: "2025-01-05T22:01:00.000Z",
    version: 1,
  },
];

class TestCalculationRepository implements DrawingCalculationRepository {
  savedAwards: PrizeAward[] = [];
  savedStatus: DrawingResult["status"] | null = null;

  async findClubById(clubId: string) { return clubId === club.id ? club : null; }
  async findDrawingById(drawingId: string) { return drawingId === drawing.id ? drawing : null; }
  async findDrawingsByLottery() { return [drawing]; }
  async findDrawingResultByDrawingAndClub() { return result; }
  async findCalculationSnapshotById(snapshotId: string) { return snapshotId === snapshot.id ? snapshot : null; }
  async findMembershipsByClub() { return memberships; }
  async findContributionsForClub() { return contributions; }
  async findPayoutConfigurationByClub(): Promise<PayoutConfiguration> {
    return { id: "pc-1", clubId: club.id, type: "equal_shares", version: 1, createdAt: club.createdAt };
  }
  async findThresholdRuleByClub(): Promise<ThresholdRule> {
    return { id: "tr-1", clubId: club.id, thresholdAmount: 100, method: "pooled", createdAt: club.createdAt };
  }
  async replacePrizeAwardsAndCompleteResult(
    _resultId: string,
    awards: PrizeAward[],
    status: DrawingResult["status"]
  ) {
    this.savedAwards = awards;
    this.savedStatus = status;
    return awards;
  }
}

test("calculates a posted drawing and persists eligible member awards", async () => {
  const repository = new TestCalculationRepository();
  const service = new DrawingCalculationService(repository, new SnapshotLotteryPrizeEvaluator());

  const calculated = await service.calculateDrawing({
    drawingId: drawing.id,
    clubId: club.id,
    cutoffAt: "2025-01-05T21:58:00-05:00",
  });

  assert.equal(calculated.result.status, "calculated");
  assert.equal(calculated.totalPrize, 1000000);
  assert.deepEqual(
    calculated.awards.map(({ userId, grossPrizeAmount, shareAmount }) => ({
      userId,
      grossPrizeAmount,
      shareAmount,
    })),
    [{ userId: "u1", grossPrizeAmount: 1000000, shareAmount: 1000000 }]
  );
  assert.equal(repository.savedStatus, "calculated");
  assert.equal(repository.savedAwards.length, 1);
});
