import { Pool } from "pg";

import { PostgresRetentionCleanup } from "../services/postgres-retention-cleanup";
import { wrapPgLikeClient } from "../services/postgres-client";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const cleanup = new PostgresRetentionCleanup(wrapPgLikeClient(pool));
    const summary = apply ? await cleanup.apply() : await cleanup.preview();
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...summary }));
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});