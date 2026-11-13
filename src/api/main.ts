import { Pool } from "pg";

import { buildClubApiServer } from "./club-api-server";
import { createOidcTokenVerifier } from "./oidc-auth";
import { PostgresClubApiRepository } from "./postgres-club-api-repository";
import { MichiganLotteryGraphqlProvider } from "../services/michigan-lottery-graphql-provider";
import { OfficialLotteryDataService } from "../services/official-lottery-data-service";
import { PostgresClubRepository } from "../services/postgres-club-repository";
import { DrawingCalculationService } from "../services/drawing-calculation-service";
import { SnapshotLotteryPrizeEvaluator } from "../services/lottery-prize-evaluator";
import { wrapPgLikeClient } from "../services/postgres-client";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured to run the authenticated API.`);
  }
  return value;
}

async function main(): Promise<void> {
  const connectionString = requiredEnvironment("DATABASE_URL");
  const issuer = requiredEnvironment("OIDC_ISSUER");
  const audience = requiredEnvironment("OIDC_AUDIENCE");
  const jwksUrl = requiredEnvironment("OIDC_JWKS_URL");
  const webOrigin = requiredEnvironment("WEB_ORIGIN");
  const port = Number(process.env.API_PORT ?? 8080);
  const webOriginUrl = new URL(webOrigin);
  if (webOriginUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(webOriginUrl.hostname)) {
    throw new Error("WEB_ORIGIN must use HTTPS outside localhost development.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT must be a valid TCP port.");
  }

  const pool = new Pool({ connectionString });
  const database = wrapPgLikeClient(pool);
  const repository = new PostgresClubApiRepository(database);
  const officialProvider = new MichiganLotteryGraphqlProvider();
  const server = await buildClubApiServer({
    repository,
    prepareTicketDrawings: async (userId, clubId, drawings) => {
      const outcomes = await Promise.allSettled(drawings.map(async (drawing) => {
        const connection = await pool.connect();
        try {
          const officialData = new OfficialLotteryDataService(
            new PostgresClubRepository(wrapPgLikeClient(connection)),
            officialProvider
          );
          return await officialData.refreshDrawing({ drawingId: drawing.id, clubId });
        } finally {
          connection.release();
        }
      }));
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        throw new Error("Official data refresh failed for one or more upcoming drawings.");
      }
    },
    recalculateDrawings: async (clubId, targets) => {
      const connection = await pool.connect();
      try {
        const calculator = new DrawingCalculationService(
          new PostgresClubRepository(wrapPgLikeClient(connection)),
          new SnapshotLotteryPrizeEvaluator()
        );
        for (const target of targets) {
          await calculator.calculateDrawing({ ...target, clubId, recalculation: true });
        }
      } finally {
        connection.release();
      }
    },
    verifyToken: createOidcTokenVerifier({
      issuer,
      audience,
      jwksUrl,
      userinfoUrl: process.env.OIDC_USERINFO_URL?.trim() || undefined,
    }),
    webOrigin,
    logger: true,
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close();
    await pool.end();
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });

  await server.listen({ host: "127.0.0.1", port });
  server.log.info({ host: "127.0.0.1", port }, "Authenticated club API listening behind HTTPS reverse proxy");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
