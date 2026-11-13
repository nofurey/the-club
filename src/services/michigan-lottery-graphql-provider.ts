import { createHash } from "node:crypto";

import type { LotteryType } from "../domain";
import type {
  FetchedOfficialResult,
  FetchedOfficialRules,
  OfficialLotteryProvider,
  OfficialSourceDocument,
  ParsedOfficialResult,
  ParsedOfficialRules,
} from "./official-lottery-data-service";
import type { Drawing } from "../domain";

const API_URL = "https://www.michiganlottery.com/api";
const SOURCE_HOST = "www.michiganlottery.com";
const POWERBALL_HOST = "www.powerball.com";
const MEGA_MILLIONS_HOST = "www.megamillions.com";
const GAME_PAGE_URLS: Record<LotteryType, string> = {
  powerball: "https://www.michiganlottery.com/games/powerball",
  mega_millions: "https://www.michiganlottery.com/games/mega-millions",
};

const GAME_IDENTIFIERS: Record<LotteryType, string> = {
  powerball: "POWERBALL",
  mega_millions: "MEGA_MILLIONS",
};

const GAME_DETAILS_QUERY = `
  query MichiganGameDetails($identifier: String) {
    getGameDetailPagesByIdentifier(identifier: $identifier) {
      title
      body
    }
  }
`;

const DRAWING_DATA_QUERY = `
  query MichiganDrawingData($logicalGameIdentifier: String, $drawDate: String) {
    winningNumbers: winningNumbers(logicalGameIdentifier: $logicalGameIdentifier, drawDate: $drawDate) {
      resultsPending
      drawNumbers
      powerball
      megaball
      megaplier
    }
    payout: payout(logicalGameIdentifier: $logicalGameIdentifier, drawDate: $drawDate) {
      resultsPending
      payoutGeneric {
        drawDate
        drawNumber
        prizeLevel
        winnerCount
        prizeAmount
        description
        alternatePrizeDescription
      }
    }
  }
`;

interface MichiganGraphqlOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

interface PrizeTableRow {
  description: string;
  prize: string;
}

export class MichiganLotteryGraphqlProvider implements OfficialLotteryProvider {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => Date;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    options: MichiganGraphqlOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  async fetchRules(lottery: LotteryType): Promise<FetchedOfficialRules> {
    const response = await this.executeGraphql("MichiganGameDetails", GAME_DETAILS_QUERY, {
      identifier: GAME_IDENTIFIERS[lottery],
    });
    const document = this.toDocument(response.rawBody, response.contentType);
    const sections = response.data.getGameDetailPagesByIdentifier;
    if (!Array.isArray(sections)) {
      throw new Error("Michigan Lottery returned no game detail sections.");
    }

    const rules = this.parseRules(sections, lottery, document);
    return { document, rules };
  }

  async fetchResult(drawing: Drawing): Promise<FetchedOfficialResult> {
    const identifier = GAME_IDENTIFIERS[drawing.lottery];
    const response = await this.executeGraphql("MichiganDrawingData", DRAWING_DATA_QUERY, {
      logicalGameIdentifier: identifier,
      drawDate: drawing.drawingDate,
    });
    const document = this.toDocument(response.rawBody, response.contentType);
    const winningNumbers = response.data.winningNumbers;
    const payout = response.data.payout;
    if (!this.isRecord(payout) || !Array.isArray(payout.payoutGeneric)) {
      throw new Error("Michigan Lottery GraphQL response is missing the payout rows field.");
    }
    const result = this.parseResult(winningNumbers, response.data.payout, drawing.lottery, drawing.drawingDate);
    return { document, result };
  }

  async fetchDrawingSize(drawing: Drawing): Promise<{
    document: OfficialSourceDocument;
    size: { drawingDate: string; estimatedJackpot: number; cashValue: number };
  } | null> {
    if (drawing.lottery === "powerball") {
      const url = new URL("https://www.powerball.com/v1/gameapi/next-drawing");
      url.searchParams.set("gamecode", "powerball");
      url.searchParams.set("language", "en");
      const document = await this.fetchSourceDocument(url.href, POWERBALL_HOST, {
        method: "GET",
        headers: { Accept: "text/html" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const drawDateUtc = document.body.match(/data-drawdateutc=["']([^"']+)["']/i)?.[1];
      if (!drawDateUtc) {
        throw new Error("Powerball next-drawing response is missing its drawing date.");
      }
      const drawingDate = this.dateAtTimeZone(drawDateUtc, "America/New_York");
      if (drawingDate !== drawing.drawingDate) {
        return null;
      }

      const estimatedJackpot = this.parsePowerballDisplayedAmount(
        this.captureDisplayedAmount(document.body, "Estimated Jackpot")
      );
      const cashValue = this.parsePowerballDisplayedAmount(
        this.captureDisplayedAmount(document.body, "Cash Value")
      );
      return { document, size: { drawingDate, estimatedJackpot, cashValue } };
    }

    const url = "https://www.megamillions.com/cmspages/utilservice.asmx/GetLatestDrawData";
    const document = await this.fetchSourceDocument(url, MEGA_MILLIONS_HOST, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", Accept: "application/json" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let response: Record<string, any>;
    try {
      response = JSON.parse(document.body);
    } catch {
      throw new Error("Mega Millions jackpot response is not valid JSON.");
    }
    if (typeof response.d !== "string") {
      throw new Error("Mega Millions jackpot response is missing its data payload.");
    }

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(response.d);
    } catch {
      throw new Error("Mega Millions jackpot data payload is not valid JSON.");
    }
    const jackpot = payload.Jackpot;
    if (!this.isRecord(jackpot) || jackpot.Verified !== true) {
      return null;
    }
    if (typeof payload.NextDrawingDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(payload.NextDrawingDate)) {
      throw new Error("Mega Millions jackpot response is missing its next drawing date.");
    }
    const drawingDate = payload.NextDrawingDate.slice(0, 10);
    if (drawingDate !== drawing.drawingDate) {
      return null;
    }

    return {
      document,
      size: {
        drawingDate,
        estimatedJackpot: this.readNonnegativeAmount(jackpot.NextPrizePool, "NextPrizePool"),
        cashValue: this.readNonnegativeAmount(jackpot.NextCashValue, "NextCashValue"),
      },
    };
  }

  private async executeGraphql(
    operationName: string,
    query: string,
    variables: Record<string, string>
  ): Promise<{ data: Record<string, any>; rawBody: string; contentType: string | null }> {
    const response = await this.fetcher(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "apollo-require-preflight": "true",
        "user-agent": "LotteryClubResults/1.0",
      },
      body: JSON.stringify({ operationName, variables, query }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });

    if (!response.ok) {
      throw new Error(`Michigan Lottery API request failed with HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      throw new Error("Michigan Lottery API response exceeds the configured size limit.");
    }

    if (new URL(response.url || API_URL).hostname !== SOURCE_HOST) {
      throw new Error("Michigan Lottery API response redirected outside its official host.");
    }

    const rawBody = await response.text();
    if (new TextEncoder().encode(rawBody).byteLength > this.maxResponseBytes) {
      throw new Error("Michigan Lottery API response exceeds the configured size limit.");
    }

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Error("Michigan Lottery API returned invalid JSON.");
    }

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(`Michigan Lottery GraphQL request failed: ${String(payload.errors[0]?.message ?? "unknown error")}`);
    }
    if (!this.isRecord(payload.data)) {
      throw new Error("Michigan Lottery GraphQL response is missing data.");
    }

    return {
      data: payload.data,
      rawBody,
      contentType: response.headers.get("content-type"),
    };
  }

  private parseRules(
    sections: unknown[],
    lottery: LotteryType,
    document: OfficialSourceDocument
  ): ParsedOfficialRules {
    const normalizedSections = sections.filter((section): section is Record<string, unknown> => this.isRecord(section));
    const howToPlay = normalizedSections.find((section) => this.asText(section.title).toLowerCase() === "how to play");
    const gameDetails = normalizedSections.find((section) => this.asText(section.title).toLowerCase() === "game details");
    const prizeTable = normalizedSections.find((section) => this.asText(section.title).toLowerCase() === "prize table");
    if (!howToPlay || !gameDetails || !prizeTable) {
      throw new Error("Michigan Lottery game details are missing a required rules section.");
    }

    const howToText = this.stripHtml(this.asText(howToPlay.body));
    const numberMatch = howToText.match(
      /choose\s+(\d+)\s+(?:(?:white|main)\s+ball\s+)?numbers?\s+from\s+(\d+)\s+to\s+(\d+)[\s\S]{0,400}?\b(?:and|plus)\s+(?:1|one)\s+(?:(?:red|gold)\s+)?(?:Powerball|Mega\s+Ball)\s+number\s+from\s+(\d+)\s+to\s+(\d+)/i
    );
    if (!numberMatch) {
      throw new Error("Michigan Lottery How to Play content has an unrecognized number format.");
    }

    const prizeRows = this.parsePrizeRows(this.asText(prizeTable.body));
    const prizeTiers = this.toPrizeTiers(prizeRows);
    const ticketCostText = this.stripHtml(this.asText(gameDetails.body));
    const ticketPriceMatch = ticketCostText.match(/Ticket\s+Cost:\s*(?:__|\*\*)?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
    const priceSnapshot: Record<string, unknown> = {
      numberRules: {
        mainNumberCount: Number(numberMatch[1]),
        mainNumberMin: Number(numberMatch[2]),
        mainNumberMax: Number(numberMatch[3]),
        bonusNumberMin: Number(numberMatch[4]),
        bonusNumberMax: Number(numberMatch[5]),
      },
      prizeTiers,
      prizeTable: prizeRows,
      source: "Michigan Lottery GraphQL game details",
    };

    if (ticketPriceMatch) {
      priceSnapshot.ticketPrice = Number(ticketPriceMatch[1].replace(/,/g, ""));
    }

    return {
      version: `sha256:${document.sha256}`,
      priceSnapshot,
      sourceUrl: GAME_PAGE_URLS[lottery],
    };
  }

  private parseResult(
    winningNumbers: unknown,
    payout: unknown,
    lottery: LotteryType,
    drawingDate: string
  ): ParsedOfficialResult | null {
    if (!this.isRecord(winningNumbers)) {
      throw new Error("Michigan Lottery GraphQL response is missing the winning numbers object.");
    }
    if (typeof winningNumbers.resultsPending !== "boolean") {
      throw new Error("Michigan Lottery GraphQL response is missing the results-pending flag.");
    }
    if (winningNumbers.resultsPending) {
      return null;
    }
    const bonusNumber = lottery === "powerball" ? winningNumbers.powerball : winningNumbers.megaball;
    if (
      winningNumbers.drawNumbers == null && bonusNumber == null &&
      drawingDate >= this.dateAtTimeZone(this.now().toISOString(), "America/New_York")
    ) {
      return null;
    }
    const mainNumberMax = lottery === "powerball" ? 69 : 70;
    const bonusNumberMax = lottery === "powerball" ? 26 : 24;
    if (
      !Array.isArray(winningNumbers.drawNumbers) ||
      winningNumbers.drawNumbers.length !== 5 ||
      winningNumbers.drawNumbers.some((number) => !Number.isInteger(number) || number < 1 || number > mainNumberMax) ||
      new Set(winningNumbers.drawNumbers).size !== winningNumbers.drawNumbers.length
    ) {
      throw new Error("Michigan Lottery GraphQL response contains invalid main winning numbers.");
    }

    if (!Number.isInteger(bonusNumber) || bonusNumber < 1 || bonusNumber > bonusNumberMax) {
      throw new Error("Michigan Lottery GraphQL response contains an invalid bonus winning number.");
    }

    const prizeBreakdown = this.parsePayout(payout);
    return {
      winningNumbers: {
        numbers: winningNumbers.drawNumbers,
        bonusNumber,
      },
      jackpotEstimate: this.readJackpotEstimate(prizeBreakdown),
      prizeBreakdown,
      postedAt: null,
    };
  }

  private readJackpotEstimate(prizeBreakdown: Record<string, unknown> | null): number | null {
    const amount = prizeBreakdown?.match_5_bonus_true;
    return typeof amount === "number" && amount > 0 ? amount : null;
  }

  private parsePayout(value: unknown): Record<string, unknown> | null {
    if (!this.isRecord(value) || !Array.isArray(value.payoutGeneric)) {
      return null;
    }

    const breakdown: Record<string, unknown> = {};
    for (const rawRow of value.payoutGeneric) {
      if (!this.isRecord(rawRow) || typeof rawRow.description !== "string") {
        continue;
      }
      const prizeType = this.prizeTypeFromDescription(rawRow.description);
      const prizeAmount = this.parseCurrency(rawRow.prizeAmount);
      if (prizeType && prizeAmount != null) {
        breakdown[prizeType] = prizeAmount;
      }
    }
    return breakdown;
  }

  private parsePrizeRows(html: string): PrizeTableRow[] {
    const table = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];
    if (!table) {
      return [];
    }
    const rows: PrizeTableRow[] = [];
    for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map((cell) => this.stripHtml(cell[1]));
      if (cells.length < 3 || /^match$/i.test(cells[0])) {
        continue;
      }
      rows.push({ description: cells[0], prize: cells[cells.length - 1] });
    }
    return rows;
  }

  private toPrizeTiers(rows: PrizeTableRow[]): Array<Record<string, unknown>> {
    const seen = new Set<string>();
    const tiers: Array<Record<string, unknown>> = [];

    for (const row of rows) {
      const prizeType = this.prizeTypeFromDescription(row.description);
      if (!prizeType || seen.has(prizeType)) {
        continue;
      }
      seen.add(prizeType);
      tiers.push({
        mainMatches: Number(prizeType.match(/^match_(\d+)_/)?.[1]),
        bonusMatches: prizeType.endsWith("_true"),
        prizeType,
        prizeAmount: /jackpot/i.test(row.prize) ? "jackpot_estimate" : "prize_breakdown",
      });
    }

    if (tiers.length === 0) {
      throw new Error("Michigan Lottery prize table did not contain parseable prize tiers.");
    }
    return tiers;
  }

  private prizeTypeFromDescription(description: string): string | null {
    const bonusMatches = /powerball|mega\s+ball/i.test(description);
    const mainMatches = description.match(/(\d+)\s+white\s+balls?/i);
    if (!mainMatches && !bonusMatches) {
      return null;
    }
    return `match_${mainMatches ? Number(mainMatches[1]) : 0}_bonus_${bonusMatches}`;
  }

  private parseCurrency(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.replace(/[$,\s]/g, "");
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
      return null;
    }
    return Number(normalized);
  }

  private stripHtml(value: string): string {
    return value
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&ndash;|&#8211;/gi, "-")
      .replace(/&mdash;|&#8212;/gi, "-")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  private asText(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private async fetchSourceDocument(
    url: string,
    expectedHost: string,
    init: RequestInit
  ): Promise<OfficialSourceDocument> {
    const response = await this.fetcher(url, init);
    if (!response.ok) {
      throw new Error(`Official jackpot request failed with HTTP ${response.status}.`);
    }
    const responseUrl = response.url || url;
    if (new URL(responseUrl).hostname !== expectedHost) {
      throw new Error("Official jackpot response redirected outside its source host.");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      throw new Error("Official jackpot response exceeds the configured size limit.");
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > this.maxResponseBytes) {
      throw new Error("Official jackpot response exceeds the configured size limit.");
    }
    return this.toDocument(body, response.headers.get("content-type"), responseUrl);
  }

  private toDocument(body: string, contentType: string | null, url = API_URL): OfficialSourceDocument {
    return {
      url,
      contentType,
      body,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      fetchedAt: this.now().toISOString(),
    };
  }

  private captureDisplayedAmount(body: string, label: string): string {
    const match = body.match(new RegExp(
      `${label}[\\s\\S]{0,800}?game-jackpot-number[^>]*>([^<]+)<`,
      "i"
    ));
    if (!match) {
      throw new Error(`Powerball next-drawing response is missing ${label}.`);
    }
    return match[1].trim();
  }

  private parsePowerballDisplayedAmount(value: string): number {
    const match = value.match(/^\$\s*([\d,]+(?:\.\d+)?)\s*(million|billion)?$/i);
    if (!match) {
      throw new Error("Powerball returned an unrecognized jackpot amount.");
    }
    const multiplier = match[2]?.toLowerCase() === "billion" ? 1000000000 :
      match[2]?.toLowerCase() === "million" ? 1000000 : 1;
    return Number(match[1].replace(/,/g, "")) * multiplier;
  }

  private readNonnegativeAmount(value: unknown, name: string): number {
    const amount = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Mega Millions ${name} must be a positive number.`);
    }
    return amount;
  }

  private dateAtTimeZone(timestamp: string, timeZone: string): string {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
      throw new Error("Powerball next-drawing response has an invalid drawing date.");
    }
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
