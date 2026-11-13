import assert from "node:assert/strict";
import test from "node:test";

import type { Drawing, DrawingResult } from "../domain";
import type { OfficialDataRefreshResult } from "./official-lottery-data-service";
import { OfficialDataCalculationRefreshService } from "./official-data-calculation-refresh";

const drawing: Drawing = {
  id: "d1000000-0000-4000-8000-000000000001",
  lottery: "powerball",
  drawingDate: "2026-11-14",
  state: "MI",
  cutoffTimeEt: "21:58:00",
  status: "results_posted",
  createdAt: "2026-11-13T00:00:00.000Z",
};

function refreshed(status: DrawingResult["status"], recalculationRequired = false): OfficialDataRefreshResult {
  return {
    snapshot: {} as OfficialDataRefreshResult["snapshot"],
    result: {
      id: "d2000000-0000-4000-8000-000000000001",
      drawingId: drawing.id,
      clubId: "d3000000-0000-4000-8000-000000000001",
      officialWinningNumbers: status === "pending" ? null : { numbers: [1, 2, 3, 4, 5], bonusNumber: 6 },
      status,
      createdAt: "2026-11-13T00:00:00.000Z",
    },
    rulesChanged: false,
    resultChanged: false,
    drawingSizeUpdated: false,
    recalculationRequired,
  };
}

test("calculates newly posted official results using the Eastern drawing cutoff", async () => {
  const calls: unknown[] = [];
  const result = await new OfficialDataCalculationRefreshService(
    { refreshDrawing: async () => refreshed("results_posted") },
    { findDrawingById: async () => drawing },
    { calculateDrawing: async (input) => { calls.push(input); return {}; } }
  ).refreshDrawing({ drawingId: drawing.id, clubId: "d3000000-0000-4000-8000-000000000001" });

  assert.equal(result.result.status, "results_posted");
  assert.deepEqual(calls, [{
    drawingId: drawing.id,
    clubId: "d3000000-0000-4000-8000-000000000001",
    cutoffAt: "2026-11-15T02:58:00.000Z",
    recalculation: false,
  }]);
});

test("marks changed completed results as recalculations", async () => {
  let recalculation = false;
  await new OfficialDataCalculationRefreshService(
    { refreshDrawing: async () => refreshed("results_posted", true) },
    { findDrawingById: async () => drawing },
    { calculateDrawing: async (input) => { recalculation = input.recalculation === true; return {}; } }
  ).refreshDrawing({ drawingId: drawing.id, clubId: "d3000000-0000-4000-8000-000000000001" });
  assert.equal(recalculation, true);
});

test("does not calculate while official results are pending or already calculated", async () => {
  let calls = 0;
  const service = new OfficialDataCalculationRefreshService(
    { refreshDrawing: async () => refreshed("pending") },
    { findDrawingById: async () => drawing },
    { calculateDrawing: async () => { calls++; return {}; } }
  );
  await service.refreshDrawing({ drawingId: drawing.id, clubId: "d3000000-0000-4000-8000-000000000001" });
  assert.equal(calls, 0);
});
