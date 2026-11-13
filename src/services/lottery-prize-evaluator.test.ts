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
  prizeBreakdown: { jackpot_winners: 1 },
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

const matchTiers = [
  { mainMatches: 5, bonusMatches: true, prizeType: "match_5_bonus_true", prizeAmount: "jackpot_estimate" },
  { mainMatches: 4, bonusMatches: true, prizeType: "match_4_bonus_true", prizeAmount: "prize_breakdown" },
  { mainMatches: 3, bonusMatches: false, prizeType: "match_3_bonus_false", prizeAmount: "prize_breakdown" },
];

function evaluateWith(options: {
  lottery?: "powerball" | "mega_millions";
  numberSets: Array<Record<string, unknown>>;
  officialWinningNumbers?: Record<string, unknown>;
  prizeBreakdown?: Record<string, unknown>;
  extraTickets?: Array<Record<string, unknown>>;
}) {
  const lottery = options.lottery ?? "powerball";
  const targetDrawing: Drawing = { ...drawing, lottery };
  const optionSnapshot: CalculationSnapshot = {
    ...snapshot,
    lottery,
    priceSnapshot: { ...snapshot.priceSnapshot, prizeTiers: matchTiers },
  };
  const optionResult: DrawingResult = {
    ...result,
    officialWinningNumbers: options.officialWinningNumbers ?? { numbers: [1, 2, 3, 4, 5], bonusNumber: 6 },
    prizeBreakdown: options.prizeBreakdown ?? {},
  };
  const tickets: Contribution[] = [options.numberSets, ...(options.extraTickets ?? []).map((set) => [set])].map((numberSets, index) => ({
    ...contribution({ id: `ticket-${index}`, userId: `u${index}`, drawingDate: drawing.drawingDate, drawingCount: 1, numbers: [1, 2, 3, 4, 5], bonusNumber: 6 }),
    lottery,
    numberSets,
  }));
  return new SnapshotLotteryPrizeEvaluator().evaluate({
    drawing: targetDrawing,
    drawings: [{ ...targetDrawing, id: "d-1", drawingDate: "2025-01-01" }, targetDrawing],
    result: optionResult,
    snapshot: optionSnapshot,
    contributions: tickets,
  });
}

test("pays Mega Millions plays by their recorded multiplier without tier collisions", async () => {
  const prizeBreakdown = { match_4_bonus_true_x2: 20000, match_4_bonus_true_x10: 100000 };
  const evaluation = await evaluateWith({
    lottery: "mega_millions",
    numberSets: [
      { numbers: [1, 2, 3, 4, 9], bonusNumber: "6", megaplier: 2 },
      { numbers: [1, 2, 3, 4, 9], bonusNumber: "6", megaplier: 10 },
    ],
    prizeBreakdown,
  });

  assert.deepEqual(evaluation.wins.map(({ prizeType, amount }) => ({ prizeType, amount })), [
    { prizeType: "match_4_bonus_true_x2", amount: 20000 },
    { prizeType: "match_4_bonus_true_x10", amount: 100000 },
  ]);
});

test("rejects winning Mega Millions plays without a multiplier or with an unsupported one", async () => {
  const prizeBreakdown = { match_4_bonus_true_x2: 20000 };
  await assert.rejects(
    () => evaluateWith({ lottery: "mega_millions", numberSets: [{ numbers: [1, 2, 3, 4, 9], bonusNumber: "6" }], prizeBreakdown }),
    /missing its recorded multiplier/i
  );
  await assert.rejects(
    () => evaluateWith({ lottery: "mega_millions", numberSets: [{ numbers: [1, 2, 3, 4, 9], bonusNumber: "6", megaplier: 6 }], prizeBreakdown }),
    /invalid Mega Millions multiplier/i
  );
  await assert.rejects(
    () => evaluateWith({ lottery: "powerball", numberSets: [{ numbers: [1, 2, 3, 4, 9], bonusNumber: "6", megaplier: 2 }], prizeBreakdown }),
    /add-ons that its lottery does not offer/i
  );
});

test("applies the official Power Play prize only to plays that bought it", async () => {
  const evaluation = await evaluateWith({
    numberSets: [
      { numbers: [1, 2, 3, 4, 9], bonusNumber: "6", powerPlay: true },
      { numbers: [1, 2, 3, 4, 9], bonusNumber: "6" },
    ],
    prizeBreakdown: { match_4_bonus_true: 50000, match_4_bonus_true_power_play: 150000 },
  });

  assert.deepEqual(evaluation.wins.map(({ prizeType, amount }) => ({ prizeType, amount })), [
    { prizeType: "match_4_bonus_true_power_play", amount: 150000 },
    { prizeType: "match_4_bonus_true", amount: 50000 },
  ]);
});

test("evaluates Double Play separately against its own numbers", async () => {
  const evaluation = await evaluateWith({
    numberSets: [{ numbers: [1, 2, 3, 4, 5], bonusNumber: "6", doublePlay: true }, { numbers: [1, 2, 3, 4, 5], bonusNumber: "6" }].slice(0, 1),
    officialWinningNumbers: { numbers: [30, 31, 32, 33, 34], bonusNumber: 20, doublePlay: { numbers: [1, 2, 3, 40, 41], bonusNumber: 6 } },
    prizeBreakdown: { double_play_match_3_bonus_true: 500 },
  });
  assert.deepEqual(evaluation.wins.map(({ prizeType, amount }) => ({ prizeType, amount })), [
    { prizeType: "double_play_match_3_bonus_true", amount: 500 },
  ]);

  await assert.rejects(
    () => evaluateWith({ numberSets: [{ numbers: [1, 2, 3, 4, 5], bonusNumber: "6", doublePlay: true }], prizeBreakdown: {} }),
    /missing the Double Play numbers/i
  );
});

test("splits the jackpot across all official winners and refuses unsafe counts", async () => {
  const jackpot = { numbers: [1, 2, 3, 4, 5], bonusNumber: "6" };
  const split = await evaluateWith({
    numberSets: [jackpot],
    extraTickets: [jackpot],
    prizeBreakdown: { jackpot_winners: 3 },
  });
  assert.deepEqual(split.wins.map(({ amount }) => amount), [8333333.33, 8333333.33]);

  await assert.rejects(
    () => evaluateWith({ numberSets: [jackpot], extraTickets: [jackpot], prizeBreakdown: { jackpot_winners: 1 } }),
    /jackpot winner count/i
  );
  await assert.rejects(
    () => evaluateWith({ numberSets: [jackpot], prizeBreakdown: {} }),
    /jackpot winner count/i
  );
});
