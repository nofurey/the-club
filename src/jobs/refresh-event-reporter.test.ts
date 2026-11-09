import assert from "node:assert/strict";
import test from "node:test";

import { createRefreshEventReporter } from "./refresh-event-reporter";

test("logs refresh events and forwards failures to the configured webhook", async () => {
  const info: string[] = [];
  const errors: string[] = [];
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const report = createRefreshEventReporter({
    webhookUrl: "https://monitor.example/hooks/refresh",
    logger: {
      info: (message) => info.push(message),
      error: (message) => errors.push(message),
    },
    fetcher: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    },
  });

  report({ type: "run_started", at: "2026-11-09T12:00:00.000Z" });
  report({
    type: "target_failed",
    failure: {
      target: { drawingId: "drawing-1", clubId: "club-1" },
      attempts: 3,
      error: "upstream unavailable",
    },
  });

  assert.equal(info.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://monitor.example/hooks/refresh");
  assert.equal(requests[0].body.type, "official_data_refresh_failure");
  assert.equal((requests[0].body.event as { type: string }).type, "target_failed");
  await report.flush();
});

test("formats Discord webhooks as messages with mentions disabled", async () => {
  let payload: Record<string, unknown> | undefined;
  const report = createRefreshEventReporter({
    webhookUrl: "https://discord.com/api/webhooks/123/secret-token",
    logger: { info: () => {}, error: () => {} },
    fetcher: async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    },
  });

  report({
    type: "target_failed",
    failure: {
      target: { drawingId: "drawing-1", clubId: "club-1" },
      attempts: 2,
      error: "API unavailable",
    },
  });
  await report.flush();

  assert.match(String(payload?.content), /Official data refresh target failed/);
  assert.match(String(payload?.content), /API unavailable/);
  assert.deepEqual(payload?.allowed_mentions, { parse: [] });
});

test("does not throw when monitoring delivery fails", async () => {
  const errors: string[] = [];
  const report = createRefreshEventReporter({
    webhookUrl: "https://monitor.example/hooks/refresh",
    logger: { info: () => {}, error: (message) => errors.push(message) },
    fetcher: async () => { throw new Error("network unavailable"); },
  });

  assert.doesNotThrow(() => report({
    type: "run_failed",
    at: "2026-11-09T12:00:00.000Z",
    error: "database unavailable",
  }));
  await assert.rejects(() => report.flush(), /network unavailable/);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /run_failed/);
  assert.match(errors[1], /alert_delivery_failed/);
});
