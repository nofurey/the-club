import assert from "node:assert/strict";
import test from "node:test";

import { drawingResultState } from "./drawing-result-state";

test("distinguishes missing results, pending calculations, and completed calculations", () => {
  const numbers = { numbers: [1, 2, 3, 4, 5], bonusNumber: 6 };
  assert.equal(drawingResultState(null), "pending_results");
  assert.equal(drawingResultState({ status: "pending", officialWinningNumbers: null }), "pending_results");
  assert.equal(drawingResultState({ status: "results_posted", officialWinningNumbers: numbers }), "pending_calculation");
  assert.equal(drawingResultState({ status: "calculated", officialWinningNumbers: numbers }), "calculated");
  assert.equal(drawingResultState({ status: "recalculated", officialWinningNumbers: numbers }), "recalculated");
});