import assert from "node:assert/strict";
import test from "node:test";

import { getDrawingCountOptions, getMaxDrawings, getMaxNumberSets, getUpcomingDrawingDates } from "./drawing-schedule";

test("generates two upcoming Michigan schedules with their sales cutoffs", () => {
  assert.deepEqual(getUpcomingDrawingDates(["powerball", "mega_millions"], "2026-11-13"), [
    { lottery: "mega_millions", drawingDate: "2026-11-13", cutoffTimeEt: "22:45:00" },
    { lottery: "powerball", drawingDate: "2026-11-14", cutoffTimeEt: "21:58:00" },
    { lottery: "mega_millions", drawingDate: "2026-11-17", cutoffTimeEt: "22:45:00" },
    { lottery: "powerball", drawingDate: "2026-11-16", cutoffTimeEt: "21:58:00" },
  ].sort((left, right) => left.drawingDate.localeCompare(right.drawingDate) || left.lottery.localeCompare(right.lottery)));
});

test("validates date and lookahead inputs", () => {
  assert.throws(() => getUpcomingDrawingDates(["powerball"], "2026-02-30"), /valid YYYY-MM-DD/);
  assert.throws(() => getUpcomingDrawingDates(["powerball"], "2026-11-13", 0), /limits/);
  assert.throws(() => getUpcomingDrawingDates(["powerball"], "2026-11-13", 3, 1), /lookahead/);
});

test("matches Michigan Number of Drawings options and panels per ticket", () => {
  assert.equal(getMaxDrawings("powerball"), 30);
  assert.equal(getMaxDrawings("mega_millions"), 26);
  assert.equal(getMaxNumberSets("powerball"), 10);
  assert.equal(getMaxNumberSets("mega_millions"), 10);
  assert.deepEqual(getDrawingCountOptions("powerball", 30), [1, 5, 10, 15, 20, 25, 30]);
  assert.deepEqual(getDrawingCountOptions("powerball", 8), [1, 5]);
  assert.deepEqual(getDrawingCountOptions("mega_millions", 26), Array.from({ length: 26 }, (_, index) => index + 1));
  assert.deepEqual(getDrawingCountOptions("mega_millions", 0), []);
  assert.equal(getDrawingCountOptions("powerball", 30).every((count) => count === 1 || count % 5 === 0), true);
});