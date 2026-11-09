import assert from "node:assert/strict";
import test from "node:test";

import { PostgresOfficialDataRefreshTargetSource } from "./postgres-official-data-refresh-target-source";

test("uses the Eastern date when querying Postgres refresh targets", async () => {
  let receivedDate = "";
  let receivedLookback = 0;
  const source = new PostgresOfficialDataRefreshTargetSource({
    async findOfficialDataRefreshTargets(asOfDate, lookbackDays) {
      receivedDate = asOfDate;
      receivedLookback = lookbackDays;
      return [{ drawingId: "drawing-1", clubId: "club-1" }];
    },
  }, 14, () => new Date("2026-11-10T02:00:00.000Z"));

  const targets = await source.getTargets();

  assert.equal(receivedDate, "2026-11-09");
  assert.equal(receivedLookback, 14);
  assert.deepEqual(targets, [{ drawingId: "drawing-1", clubId: "club-1" }]);
});