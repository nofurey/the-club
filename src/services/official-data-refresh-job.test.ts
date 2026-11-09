import assert from "node:assert/strict";
import test from "node:test";

import type { OfficialDataRefreshInput } from "./official-lottery-data-service";
import { OfficialDataRefreshJob } from "./official-data-refresh-job";

const targetA: OfficialDataRefreshInput = { drawingId: "drawing-a", clubId: "club-a" };
const targetB: OfficialDataRefreshInput = { drawingId: "drawing-b", clubId: "club-b" };

test("deduplicates targets, retries transient failures, and reports run outcomes", async () => {
  const attempts = new Map<string, number>();
  const delays: number[] = [];
  const events: string[] = [];
  const job = new OfficialDataRefreshJob(
    { getTargets: async () => [targetA, targetA, targetB] },
    {
      async refreshDrawing(target) {
        const count = (attempts.get(target.drawingId) ?? 0) + 1;
        attempts.set(target.drawingId, count);
        if (target.drawingId === targetA.drawingId && count < 3) {
          throw new Error("temporary source failure");
        }
      },
    },
    {
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      minTargetIntervalMs: 0,
      delay: async (milliseconds) => { delays.push(milliseconds); },
      onEvent: (event) => { events.push(event.type); },
    }
  );

  const summary = await job.runOnce();

  assert.equal(summary.targetCount, 2);
  assert.equal(summary.succeeded, 2);
  assert.deepEqual(summary.failures, []);
  assert.equal(attempts.get(targetA.drawingId), 3);
  assert.equal(attempts.get(targetB.drawingId), 1);
  assert.deepEqual(delays, [10, 20]);
  assert.ok(events.includes("target_succeeded"));
  assert.equal(events.at(-1), "run_completed");
});

test("continues after exhausted retries and prevents overlapping runOnce calls", async () => {
  let calls = 0;
  let releaseRefresh: (() => void) | undefined;
  let enterRefresh: (() => void) | undefined;
  const refreshEntered = new Promise<void>((resolve) => { enterRefresh = resolve; });
  const waitForRelease = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const job = new OfficialDataRefreshJob(
    { getTargets: async () => [targetA, targetB] },
    {
      async refreshDrawing(target) {
        calls += 1;
        if (target.drawingId === targetA.drawingId) {
          throw new Error("unavailable");
        }
        enterRefresh?.();
        await waitForRelease;
      },
    },
    {
      maxAttempts: 2,
      retryBaseDelayMs: 1,
      minTargetIntervalMs: 0,
      delay: async () => {},
    }
  );

  const firstRun = job.runOnce();
  await refreshEntered;
  const overlappingRun = job.runOnce();
  assert.equal(overlappingRun, firstRun);
  releaseRefresh?.();

  const summary = await firstRun;
  assert.equal(calls, 3);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].target.drawingId, targetA.drawingId);
  assert.equal(summary.failures[0].attempts, 2);
});

test("enforces minimum spacing between target refreshes", async () => {
  let clock = 0;
  const starts: number[] = [];
  const delays: number[] = [];
  const job = new OfficialDataRefreshJob(
    { getTargets: async () => [targetA, targetB] },
    {
      async refreshDrawing() { starts.push(clock); },
    },
    {
      minTargetIntervalMs: 100,
      now: () => new Date(clock),
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      },
    }
  );

  await job.runOnce();

  assert.deepEqual(starts, [0, 100]);
  assert.deepEqual(delays, [100]);
});

test("start and stop manage one refresh interval", () => {
  let intervalCallback: (() => void) | undefined;
  let intervalHandle: object | undefined;
  let cleared: unknown;
  const job = new OfficialDataRefreshJob(
    { getTargets: async () => [] },
    { refreshDrawing: async () => {} },
    {
      intervalMs: 60_000,
      timerDriver: {
        setInterval(callback, milliseconds) {
          assert.equal(milliseconds, 60_000);
          intervalCallback = callback;
          intervalHandle = {};
          return intervalHandle;
        },
        clearInterval(handle) { cleared = handle; },
      },
    }
  );

  job.start();
  assert.throws(() => job.start(), /already running/i);
  job.stop();
  assert.equal(cleared, intervalHandle);
  assert.equal(intervalCallback !== undefined, true);
});
