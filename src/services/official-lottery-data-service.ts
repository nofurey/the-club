import { createHash, randomUUID } from "node:crypto";

import type {
  CalculationSnapshot,
  Drawing,
  DrawingResult,
  LotteryType,
} from "../domain";
import { SnapshotLotteryPrizeEvaluator } from "./lottery-prize-evaluator";

export interface OfficialSourceDocument {
  url: string;
  contentType: string | null;
  body: string;
  sha256: string;
  fetchedAt: string;
}

export interface ParsedOfficialRules {
  version: string;
  priceSnapshot: Record<string, unknown>;
  sourceUrl?: string;
}

export interface ParsedOfficialResult {
  winningNumbers: Record<string, unknown>;
  jackpotEstimate: number | null;
  prizeBreakdown: Record<string, unknown> | null;
  postedAt: string | null;
}

export interface OfficialLotterySourceDefinition {
  rulesUrl: string;
  resultsUrl: string | ((drawing: Drawing) => string);
  allowedHosts: string[];
  parseRules?: (document: OfficialSourceDocument, lottery: LotteryType) => ParsedOfficialRules;
  parseResult?: (document: OfficialSourceDocument, drawing: Drawing) => ParsedOfficialResult | null;
}

export interface FetchedOfficialRules {
  document: OfficialSourceDocument;
  rules: ParsedOfficialRules;
}

export interface FetchedOfficialResult {
  document: OfficialSourceDocument;
  result: ParsedOfficialResult | null;
}

export interface OfficialLotteryProvider {
  fetchRules(lottery: LotteryType): Promise<FetchedOfficialRules>;
  fetchResult(drawing: Drawing): Promise<FetchedOfficialResult>;
}

export interface OfficialDataRepository {
  findDrawingById(drawingId: string): Promise<Drawing | null>;
  storeOfficialData(
    snapshot: CalculationSnapshot,
    result: DrawingResult,
    officialResultPostedAt: string | null
  ): Promise<{ snapshot: CalculationSnapshot; result: DrawingResult; rulesChanged: boolean; resultChanged: boolean }>;
}

export interface OfficialDataRefreshInput {
  drawingId: string;
  clubId: string;
}

export interface OfficialDataRefreshResult {
  snapshot: CalculationSnapshot;
  result: DrawingResult;
  rulesChanged: boolean;
  resultChanged: boolean;
}

export interface HttpOfficialLotteryProviderOptions {
  timeoutMs?: number;
  maxDocumentBytes?: number;
  responseUrl?: (response: Response, requestUrl: string) => string;
  now?: () => Date;
}

export class HttpOfficialLotteryProvider implements OfficialLotteryProvider {
  private readonly timeoutMs: number;
  private readonly maxDocumentBytes: number;
  private readonly responseUrl: (response: Response, requestUrl: string) => string;
  private readonly now: () => Date;

  constructor(
    private readonly definitions: Partial<Record<LotteryType, OfficialLotterySourceDefinition>>,
    private readonly fetcher: typeof fetch = fetch,
    options: HttpOfficialLotteryProviderOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxDocumentBytes = options.maxDocumentBytes ?? 2 * 1024 * 1024;
    this.responseUrl = options.responseUrl ?? ((response, requestUrl) => response.url || requestUrl);
    this.now = options.now ?? (() => new Date());
  }

  async fetchRules(lottery: LotteryType): Promise<FetchedOfficialRules> {
    const definition = this.getDefinition(lottery);
    const document = await this.fetchDocument(definition.rulesUrl, definition.allowedHosts);
    const rules = definition.parseRules
      ? definition.parseRules(document, lottery)
      : this.parseJsonRules(document);

    return { document, rules };
  }

  async fetchResult(drawing: Drawing): Promise<FetchedOfficialResult> {
    const definition = this.getDefinition(drawing.lottery);
    const url = typeof definition.resultsUrl === "function"
      ? definition.resultsUrl(drawing)
      : definition.resultsUrl;
    const document = await this.fetchDocument(url, definition.allowedHosts);
    const result = definition.parseResult
      ? definition.parseResult(document, drawing)
      : this.parseJsonResult(document);

    return { document, result };
  }

  private async fetchDocument(url: string, allowedHosts: string[]): Promise<OfficialSourceDocument> {
    const requestedUrl = this.validateUrl(url, allowedHosts);
    const response = await this.fetcher(requestedUrl.href, {
      method: "GET",
      headers: { Accept: "application/json, text/html;q=0.9, */*;q=0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Official source request failed with HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxDocumentBytes) {
      throw new Error("Official source document exceeds the configured size limit.");
    }

    const finalUrl = this.validateUrl(this.responseUrl(response, requestedUrl.href), allowedHosts);
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > this.maxDocumentBytes) {
      throw new Error("Official source document exceeds the configured size limit.");
    }

    return {
      url: finalUrl.href,
      contentType: response.headers.get("content-type"),
      body,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      fetchedAt: this.now().toISOString(),
    };
  }

  private validateUrl(value: string, allowedHosts: string[]): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Official source URL is invalid.");
    }

    if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) {
      throw new Error("Official source URL is outside the configured host allowlist.");
    }
    return url;
  }

  private getDefinition(lottery: LotteryType): OfficialLotterySourceDefinition {
    const definition = this.definitions[lottery];
    if (!definition || definition.allowedHosts.length === 0) {
      throw new Error(`No official source is configured for ${lottery}.`);
    }
    return definition;
  }

  private parseJsonRules(document: OfficialSourceDocument): ParsedOfficialRules {
    const value = this.parseJsonDocument(document, "rules");
    if (!this.isRecord(value) || typeof value.version !== "string" || !this.isRecord(value.priceSnapshot)) {
      throw new Error("Official rules JSON must contain a version and priceSnapshot object.");
    }
    return { version: value.version, priceSnapshot: value.priceSnapshot };
  }

  private parseJsonResult(document: OfficialSourceDocument): ParsedOfficialResult | null {
    const value = this.parseJsonDocument(document, "result");
    if (!this.isRecord(value)) {
      throw new Error("Official result JSON must be an object.");
    }
    if (value.winningNumbers == null) {
      return null;
    }
    if (!this.isRecord(value.winningNumbers)) {
      throw new Error("Official result winningNumbers must be an object.");
    }

    return {
      winningNumbers: value.winningNumbers,
      jackpotEstimate: value.jackpotEstimate == null ? null : this.readNonnegativeAmount(value.jackpotEstimate, "jackpotEstimate"),
      prizeBreakdown: value.prizeBreakdown == null ? null : this.asRecord(value.prizeBreakdown, "prizeBreakdown"),
      postedAt: value.postedAt == null ? null : this.readTimestamp(value.postedAt, "postedAt"),
    };
  }

  private parseJsonDocument(document: OfficialSourceDocument, kind: string): unknown {
    try {
      return JSON.parse(document.body);
    } catch {
      throw new Error(`Official ${kind} response is not valid JSON and requires a source-specific parser.`);
    }
  }

  private readNonnegativeAmount(value: unknown, name: string): number {
    const amount = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`Official result ${name} must be a nonnegative amount.`);
    }
    return amount;
  }

  private readTimestamp(value: unknown, name: string): string {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      throw new Error(`Official result ${name} must be a valid timestamp.`);
    }
    return new Date(value).toISOString();
  }

  private asRecord(value: unknown, name: string): Record<string, unknown> {
    if (!this.isRecord(value)) {
      throw new Error(`Official result ${name} must be an object.`);
    }
    return value;
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export class OfficialLotteryDataService {
  private readonly prizeEvaluator = new SnapshotLotteryPrizeEvaluator();

  constructor(
    private readonly repository: OfficialDataRepository,
    private readonly provider: OfficialLotteryProvider,
    private readonly now: () => Date = () => new Date()
  ) {}

  async refreshDrawing({ drawingId, clubId }: OfficialDataRefreshInput): Promise<OfficialDataRefreshResult> {
    const drawing = await this.repository.findDrawingById(drawingId);
    if (!drawing) {
      throw new Error("Drawing not found.");
    }

    const [fetchedRules, fetchedResult] = await Promise.all([
      this.provider.fetchRules(drawing.lottery),
      this.provider.fetchResult(drawing),
    ]);
    if (
      typeof fetchedRules.rules.version !== "string" ||
      !fetchedRules.rules.version.trim() ||
      !this.isRecord(fetchedRules.rules.priceSnapshot)
    ) {
      throw new Error("Official rules version is required.");
    }
    this.prizeEvaluator.validateSnapshot(fetchedRules.rules.priceSnapshot);

    const officialResult = fetchedResult.result;
    if (officialResult) {
      this.validateOfficialResult(officialResult);
      this.prizeEvaluator.validateOfficialNumbers(officialResult.winningNumbers, fetchedRules.rules.priceSnapshot);
    }

    const snapshot: CalculationSnapshot = {
      id: randomUUID(),
      drawingId,
      clubId,
      lottery: drawing.lottery,
      rulesUrl: fetchedRules.rules.sourceUrl ?? fetchedRules.document.url,
      rulesVersion: fetchedRules.rules.version,
      priceSnapshot: fetchedRules.rules.priceSnapshot,
      capturedAt: fetchedRules.document.fetchedAt,
      sourceContentType: fetchedRules.document.contentType,
      sourceDocument: fetchedRules.document.body,
      sourceSha256: fetchedRules.document.sha256,
      sourceDocumentUrl: fetchedRules.document.url,
    };
    const result: DrawingResult = {
      id: randomUUID(),
      drawingId,
      clubId,
      officialWinningNumbers: officialResult?.winningNumbers ?? null,
      jackpotEstimate: officialResult?.jackpotEstimate ?? null,
      prizeBreakdown: officialResult?.prizeBreakdown ?? null,
      status: officialResult ? "results_posted" : "pending",
      calculationStartedAt: null,
      calculatedAt: null,
      sourceSnapshotId: snapshot.id,
      createdAt: this.now().toISOString(),
      officialSourceUrl: fetchedResult.document.url,
      officialSourceContentType: fetchedResult.document.contentType,
      officialSourceDocument: fetchedResult.document.body,
      officialSourceSha256: fetchedResult.document.sha256,
    };

    return this.repository.storeOfficialData(snapshot, result, officialResult?.postedAt ?? null);
  }

  private validateOfficialResult(result: ParsedOfficialResult): void {
    if (!this.isRecord(result.winningNumbers)) {
      throw new Error("Official result has an invalid winning number format.");
    }
    const numbers = result.winningNumbers.numbers;
    const bonusNumber = result.winningNumbers.bonusNumber;
    if (
      !Array.isArray(numbers) ||
      numbers.length === 0 ||
      numbers.some((number) => !Number.isInteger(number)) ||
      new Set(numbers).size !== numbers.length ||
      (typeof bonusNumber !== "number" && typeof bonusNumber !== "string")
    ) {
      throw new Error("Official result has an invalid winning number format.");
    }
    if (result.jackpotEstimate != null && (!Number.isFinite(result.jackpotEstimate) || result.jackpotEstimate < 0)) {
      throw new Error("Official result has an invalid jackpot estimate.");
    }
    if (result.postedAt != null && !Number.isFinite(Date.parse(result.postedAt))) {
      throw new Error("Official result has an invalid posted timestamp.");
    }
    if (result.prizeBreakdown != null && !this.isRecord(result.prizeBreakdown)) {
      throw new Error("Official result has an invalid prize breakdown.");
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
