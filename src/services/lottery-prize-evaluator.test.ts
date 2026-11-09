import assert from "node:assert/strict";
import test from "node:test";

import type { CalculationSnapshot, Contribution, Drawing, DrawingResult } from "../domain";
import { SnapshotLotteryPrizeEvaluator } from "./lottery-prize-evaluator";

const drawing: Drawing = {
  id: "drawing-3",
  lottery: "powerball",
  drawingDate: "2025-01-05",
  state: "MI",
  cutoffTimeEt: "21:58:00",
  officialResultPostedAt: "2025-01-05T22:30:00.000Z",
  status: "results_posted",
  createdAt: "2025-01-01T00:00:00.000Z",
};

const priorDrawings: Drawing[] = [
  { ...drawing, id: "drawing-1", drawingDate: "2025-01-01" },
  { ...drawing, id: "drawing-2", drawingDate: "2025-01-03" },
  drawing,
];

const snapshot: CalculationSnapshot = {
  id: "snapshot-1",
  drawingId: drawing.id,
  clubId: "club-1",
  lottery: "powerball",
  rulesUrl: "https://example.test/official-rules",
  rulesVersion: "2025-01",
  priceSnapshot: {
    numberRules: {
      mainNumberCount: 5,
      mainNumberMin: 1,
      mainNumberMax: 69,
      bonusNumberMin: 1,
      bonusNumberMax: 26,
    },
    prizeTiers: [
      { mainMatches: 5, bonusMatches: true, prizeType: "jackpot", prizeAmount: "jackpot_estimate" },
      { mainMatches: 4, bonusMatches: true, prizeType: "four-plus-powerball", prizeAmount: 50000 },
    ],
  },
  capturedAt: "2025-01-05T22:30:00.000Z",
};

const result: DrawingResult = {
  id: "result-1",
  drawingId: drawing.id,
  clubId: "club-1",
  officialWinningNumbers: { numbers: [1, 2, 3, 4, 5], bonusNumber: 6 },
  jackpotEstimate: 25000000,
  prizeBreakdown: {},
  status: "results_posted",
  sourceSnapshotId: snapshot.id,
  createdAt: "2025-01-05T22:30:00.000Z",
};

function contribution(input: {
  id: string;
  userId: string;
  drawingDate: string;
  drawingCount: number;
  numbers: number[];
  bonusNumber: number;
}): Contribution {
  return {
    id: input.id,
    clubId: "club-1",
    userId: input.userId,
    lottery: "powerball",
    drawingDate: input.drawingDate,
    drawingCount: input.drawingCount,
    numberSets: [{ numbers: input.numbers, bonusNumber: String(input.bonusNumber) }],
    costUsd: 2,
    status: "submitted",
    createdAt: "2025-01-05T20:00:00.000Z",
    updatedAt: "2025-01-05T20:00:00.000Z",
    version: 1,
  };
}

test("matches number sets against snapshot tiers and includes the target in multi-draw tickets", async () => {
  const evaluator = new SnapshotLotteryPrizeEvaluator();
  const contributions = [
    contribution({ id: "ticket-multidraw", userId: "u1", drawingDate: "2025-01-03", drawingCount: 2, numbers: [1, 2, 3, 4, 5], bonusNumber: 6 }),
    contribution({ id: "ticket-expired", userId: "u2", drawingDate: "2025-01-01", drawingCount: 1, numbers: [1, 2, 3, 4, 5], bonusNumber: 6 }),
    contribution({ id: "ticket-near-match", userId: "u3", drawingDate: "2025-01-05", drawingCount: 1, numbers: [1, 2, 3, 4, 8], bonusNumber: 6 }),
  ];

  const evaluation = await evaluator.evaluate({ drawing, drawings: priorDrawings, result, snapshot, contributions });

  assert.deepEqual(evaluation.drawingContributionIds, ["ticket-multidraw", "ticket-near-match"]);
  assert.deepEqual(evaluation.wins, [
    { contributionId: "ticket-multidraw", userId: "u1", prizeType: "jackpot", amount: 25000000 },
    { contributionId: "ticket-near-match", userId: "u3", prizeType: "four-plus-powerball", amount: 50000 },
  ]);
});

test("uses drawing-specific prize breakdown values for variable prize tiers", async () => {
  const evaluator = new SnapshotLotteryPrizeEvaluator();
  const variableSnapshot = {
    ...snapshot,
    priceSnapshot: {
      ...snapshot.priceSnapshot,
      prizeTiers: [{ mainMatches: 4, bonusMatches: true, prizeType: "four-plus-powerball", prizeAmount: "prize_breakdown" }],
    },
  };
  const variableResult = { ...result, prizeBreakdown: { "four-plus-powerball": 75000 } };
  const ticket = contribution({
    id: "ticket-1",
    userId: "u1",
    drawingDate: drawing.drawingDate,
    drawingCount: 1,
    numbers: [1, 2, 3, 4, 8],
    bonusNumber: 6,
  });

  const evaluation = await evaluator.evaluate({
    drawing,
    drawings: priorDrawings,
    result: variableResult,
    snapshot: variableSnapshot,
    contributions: [ticket],
  });

  assert.equal(evaluation.wins[0]?.amount, 75000);
});

test("supports Mega Millions formats and rule ranges from its own snapshot", async () => {
  const evaluator = new SnapshotLotteryPrizeEvaluator();
  const megaDrawing: Drawing = { ...drawing, lottery: "mega_millions" };
  const megaSnapshot: CalculationSnapshot = {
    ...snapshot,
    lottery: "mega_millions",
    priceSnapshot: {
      numberRules: {
        mainNumberCount: 5,
        mainNumberMin: 1,
        mainNumberMax: 70,
        bonusNumberMin: 1,
        bonusNumberMax: 24,
      },
      prizeTiers: [{ mainMatches: 0, bonusMatches: true, prizeType: "mega-ball-only", prizeAmount: 10 }],
    },
  };
  const megaResult: DrawingResult = {
    ...result,
    officialWinningNumbers: { numbers: [1, 2, 3, 4, 5], bonusNumber: 24 },
  };
  const megaTicket: Contribution = {
    ...contribution({
      id: "mega-ticket",
      userId: "u1",
      drawingDate: drawing.drawingDate,
      drawingCount: 1,
      numbers: [6, 7, 8, 9, 10],
      bonusNumber: 24,
    }),
    lottery: "mega_millions",
  };

  const evaluation = await evaluator.evaluate({
    drawing: megaDrawing,
    drawings: [{ ...megaDrawing, id: "mega-drawing-1", drawingDate: "2025-01-01" }, megaDrawing],
    result: megaResult,
    snapshot: megaSnapshot,
    contributions: [megaTicket],
  });

  assert.deepEqual(evaluation.wins, [
    { contributionId: "mega-ticket", userId: "u1", prizeType: "mega-ball-only", amount: 10 },
  ]);
});

test("rejects malformed official numbers and incomplete prize snapshots", async () => {
  const evaluator = new SnapshotLotteryPrizeEvaluator();

  await assert.rejects(
    () => evaluator.evaluate({
      drawing,
      drawings: priorDrawings,
      result: { ...result, officialWinningNumbers: { numbers: [1, 2, 3], bonusNumber: 6 } },
      snapshot,
      contributions: [],
    }),
    /winning numbers/i
  );

  await assert.rejects(
    () => evaluator.evaluate({
      drawing,
      drawings: priorDrawings,
      result,
      snapshot: { ...snapshot, priceSnapshot: {} },
      contributions: [],
    }),
    /prize rules/i
  );
});
