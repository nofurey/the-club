import { Pool } from "pg";

import { createMichiganPostgresOfficialDataRefreshJob } from "../services/official-data-refresh-runtime";
import { PostgresClubRepository } from "../services/postgres-club-repository";
import { wrapPgLikeClient } from "../services/postgres-client";
import { createRefreshEventReporter } from "./refresh-event-reporter";

async function main(): Promise<void> {
  const webhookUrl = process.env.REFRESH_ALERT_WEBHOOK_URL;
  const reportEvent = createRefreshEventReporter({ webhookUrl });
  if (process.argv.includes("--test-alert")) {
    if (!webhookUrl) {
      throw new Error("REFRESH_ALERT_WEBHOOK_URL must be set to test alert delivery.");
    }
    reportEvent({
      type: "run_failed",
      at: new Date().toISOString(),
      error: "Manual test alert: official-data refresh webhook delivery check.",
    });
    await reportEvent.flush();
    console.info(JSON.stringify({ component: "official-data-refresh", type: "alert_test_delivered" }));
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to run the official-data refresh worker.");
  }

  const pool = new Pool({ connectionString });
  const repository = new PostgresClubRepository(wrapPgLikeClient(pool));
  const job = createMichiganPostgresOfficialDataRefreshJob(repository, { onEvent: reportEvent });

  if (process.argv.includes("--once")) {
    try {
      await job.runOnce();
    } finally {
      await pool.end();
    }
    return;
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    job.stop();
    await pool.end();
  };

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });

  job.start();
  void job.runOnce().catch((error: unknown) => {
    console.error(JSON.stringify({
      component: "official-data-refresh",
      type: "initial_run_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  });
  console.info(JSON.stringify({ component: "official-data-refresh", type: "worker_started" }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
