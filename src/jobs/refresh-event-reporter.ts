import type { RefreshJobEvent } from "../services/official-data-refresh-job";

export interface RefreshEventLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface RefreshEventReporterOptions {
  webhookUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  logger?: RefreshEventLogger;
}

export type RefreshEventReporter = ((event: RefreshJobEvent) => void) & {
  flush: () => Promise<void>;
};

export function createRefreshEventReporter({
  webhookUrl,
  timeoutMs = 5000,
  fetcher = fetch,
  logger = console,
}: RefreshEventReporterOptions = {}): RefreshEventReporter {
  const endpoint = webhookUrl ? new URL(webhookUrl) : null;
  if (endpoint && endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("Refresh alert webhook URL must use HTTP or HTTPS.");
  }

  const pendingDeliveries = new Set<Promise<Error | null>>();
  const report = ((event: RefreshJobEvent) => {
    const message = JSON.stringify({ component: "official-data-refresh", ...event });
    const isFailure = event.type === "target_failed" || event.type === "run_failed";
    (isFailure ? logger.error : logger.info)(message);

    if (!isFailure || !endpoint) {
      return;
    }

    const body = isDiscordWebhook(endpoint)
      ? createDiscordPayload(event)
      : { type: "official_data_refresh_failure", event };
    const delivery = fetcher(endpoint.href, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`alert endpoint returned HTTP ${response.status}`);
      }
      return null;
    }).catch((error: unknown) => {
      const deliveryError = error instanceof Error ? error : new Error(String(error));
      logger.error(JSON.stringify({
        component: "official-data-refresh",
        type: "alert_delivery_failed",
        error: deliveryError.message,
      }));
      return deliveryError;
    });
    pendingDeliveries.add(delivery);
    void delivery.finally(() => pendingDeliveries.delete(delivery));
  }) as RefreshEventReporter;

  report.flush = async () => {
    const failures = (await Promise.all([...pendingDeliveries])).filter((error): error is Error => error !== null);
    if (failures.length > 0) {
      throw failures[0];
    }
  };

  return report;
}

function isDiscordWebhook(url: URL): boolean {
  return (url.hostname === "discord.com" || url.hostname === "discordapp.com") &&
    url.pathname.startsWith("/api/webhooks/");
}

function createDiscordPayload(event: RefreshJobEvent): Record<string, unknown> {
  const title = event.type === "target_failed"
    ? "Official data refresh target failed"
    : "Official data refresh run failed";
  const detail = event.type === "target_failed"
    ? `Drawing: ${event.failure.target.drawingId}\nClub: ${event.failure.target.clubId}\nAttempts: ${event.failure.attempts}\nError: ${event.failure.error}`
    : event.type === "run_failed" ? event.error : "";

  return {
    content: `**${title}**\n${detail.slice(0, 1700)}`,
    allowed_mentions: { parse: [] },
  };
}
