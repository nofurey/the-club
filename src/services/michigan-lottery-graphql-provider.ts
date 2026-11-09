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
    const result = this.parseResult(winningNumbers, response.data.payout, drawing.lottery);
    return { document, result };
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
    const ticketPriceMatch = ticketCostText.match(/Ticket\s+Cost:\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
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
    lottery: LotteryType
  ): ParsedOfficialResult | null {
    if (!this.isRecord(winningNumbers) || winningNumbers.resultsPending === true) {
      return null;
    }
    if (!Array.isArray(winningNumbers.drawNumbers) || winningNumbers.drawNumbers.length === 0) {
      return null;
    }

    const bonusNumber = lottery === "powerball" ? winningNumbers.powerball : winningNumbers.megaball;
    if (bonusNumber == null) {
      throw new Error("Michigan Lottery returned draw numbers without the bonus number.");
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

  private toDocument(body: string, contentType: string | null): OfficialSourceDocument {
    return {
      url: API_URL,
      contentType,
      body,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      fetchedAt: this.now().toISOString(),
    };
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
