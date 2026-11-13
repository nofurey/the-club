import { Pool } from "pg";

import { buildClubApiServer } from "./club-api-server";
import { createOidcTokenVerifier } from "./oidc-auth";
import { PostgresClubApiRepository } from "./postgres-club-api-repository";
import { MichiganLotteryGraphqlProvider } from "../services/michigan-lottery-graphql-provider";
import { MuslVerifiedLotteryProvider } from "../services/musl-verified-lottery-provider";
import { OfficialLotteryDataService } from "../services/official-lottery-data-service";
import { PostgresClubRepository } from "../services/postgres-club-repository";
import { DrawingCalculationService } from "../services/drawing-calculation-service";
import { SnapshotLotteryPrizeEvaluator } from "../services/lottery-prize-evaluator";
import { PostgresNotificationEmailDelivery } from "../services/notification-email-delivery";
import { createSmtpNotificationEmailSender } from "../services/smtp-notification-email-sender";
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
  const emailSender = createSmtpNotificationEmailSender();
  const emailDelivery = emailSender ? new PostgresNotificationEmailDelivery(database, emailSender) : null;
  const officialProvider = new MuslVerifiedLotteryProvider(new MichiganLotteryGraphqlProvider());
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

  let notificationTimer: ReturnType<typeof setInterval> | null = null;
  let notificationDeliveryRunning = false;
  if (emailDelivery && emailSender) {
    const deliverQueuedEmails = async () => {
      if (notificationDeliveryRunning) return;
      notificationDeliveryRunning = true;
      try {
        const summary = await emailDelivery.deliverQueued();
        if (summary.sent || summary.failed) server.log.info(summary, "Notification email batch completed");
      } catch (error) {
        server.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Notification email batch failed");
      } finally {
        notificationDeliveryRunning = false;
      }
    };
    void deliverQueuedEmails();
    notificationTimer = setInterval(() => { void deliverQueuedEmails(); }, 60_000);
    notificationTimer.unref();
  } else {
    server.log.warn("Notification SMTP is not configured; email notifications remain queued");
  }

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    if (notificationTimer) clearInterval(notificationTimer);
    emailSender?.close();
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
