import { createHash } from "node:crypto";

import type { LotteryType } from "../domain";
import type { OfficialSourceDocument } from "./official-lottery-data-service";
import { POWERBALL_PRIZE_TIERS } from "./ticket-options";

const POWERBALL_HOST = "www.powerball.com";
const MEGA_MILLIONS_HOST = "www.megamillions.com";
const DOT_NET_EPOCH_TICKS = 621355968000000000n;
const MEGAPLIER_COLUMNS: Array<[string, number]> = [["Mega2", 2], ["Mega3", 3], ["Mega4", 4], ["Mega5", 5], ["Mega10", 10]];

export interface MuslNumberSet {
  numbers: number[];
  bonusNumber: number;
}

export interface MuslDrawDetail {
  lottery: LotteryType;
  drawingDate: string;
  main: MuslNumberSet;
  powerPlayMultiplier: number | null;
  doublePlay: MuslNumberSet | null;
  jackpot: { estimate: number; cashValue: number; winners: number };
  prizes: Record<string, number>;
  documents: OfficialSourceDocument[];
}

export function prizeKey(mainMatches: number, bonusMatches: boolean): string {
  return `match_${mainMatches}_bonus_${bonusMatches}`;
}

export function megaMillionsTicks(drawingDate: string): string {
  const match = drawingDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error("Drawing date must use YYYY-MM-DD.");
  }
  const milliseconds = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (BigInt(milliseconds) * 10000n + DOT_NET_EPOCH_TICKS).toString();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function parseDisplayedAmount(value: string, label: string): number {
  const match = value.match(/^\$\s*([\d,]+(?:\.\d+)?)\s*(million|billion)?$/i);
  if (!match) {
    throw new Error(`Powerball draw page has an unrecognized ${label}.`);
  }
  const scale = match[2]?.toLowerCase() === "billion" ? 1e9 : match[2]?.toLowerCase() === "million" ? 1e6 : 1;
  return Math.round(Number(match[1].replace(/,/g, "")) * scale);
}

function parsePrizeCell(value: string): number | null {
  const match = value.match(/^\$([\d,]+(?:\.\d+)?)$/);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function parseCountCell(value: string, label: string): number {
  if (!/^\d[\d,]*$/.test(value)) {
    throw new Error(`Powerball draw page has an invalid ${label}.`);
  }
  return Number(value.replace(/,/g, ""));
}

function pageDate(html: string): string {
  const text = stripTags(html.match(/class="[^"]*title-date[^"]*"[^>]*>([\s\S]*?)<\/h5>/i)?.[1] ?? "");
  const match = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})/);
  const month = match ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[1].slice(0, 3).toLowerCase()) : -1;
  if (!match || month < 0) {
    throw new Error("Powerball draw page is missing its drawing date.");
  }
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

export interface ParsedPowerballPage {
  numbers: MuslNumberSet;
  powerPlayMultiplier: number | null;
  jackpotEstimate: number | null;
  jackpotCashValue: number | null;
  rows: Array<{ mainMatches: number; bonusMatches: boolean; winners: number; prize: number | null; powerPlayPrize: number | null }>;
}

export function parsePowerballDrawPage(html: string, drawingDate: string, game: "powerball" | "double_play"): ParsedPowerballPage {
  if (pageDate(html) !== drawingDate) {
    throw new Error("Powerball draw page is for a different drawing date.");
  }

  const whiteBalls = [...html.matchAll(/class="form-control col (?:white|black)-balls[^"]*">\s*<div>\s*(\d+)\s*<\/div>/gi)].map((match) => Number(match[1]));
  const bonusBalls = [...html.matchAll(/class="form-control col (?:dp-)?powerball[^"]*">\s*<div>\s*(\d+)\s*<\/div>/gi)].map((match) => Number(match[1]));
  if (whiteBalls.length !== 5 || bonusBalls.length !== 1 || new Set(whiteBalls).size !== 5) {
    throw new Error("Powerball draw page is missing complete winning numbers.");
  }
  const mainMax = 69;
  const bonusMax = 26;
  if (whiteBalls.some((number) => number < 1 || number > mainMax) || bonusBalls[0] < 1 || bonusBalls[0] > bonusMax) {
    throw new Error("Powerball draw page contains out-of-range winning numbers.");
  }

  const multiplierText = html.match(/<span class="multiplier">\s*(\d+)x\s*<\/span>/i)?.[1];
  const powerPlayMultiplier = multiplierText ? Number(multiplierText) : null;
  if (game === "powerball" && powerPlayMultiplier == null) {
    throw new Error("Powerball draw page is missing the Power Play multiplier.");
  }

  const jackpotText = (label: string) => {
    const value = html.match(new RegExp(`${label}:\\s*<\\/span>\\s*<span>([^<]+)<\\/span>`, "i"))?.[1];
    return value ? stripTags(value) : null;
  };
  const estimate = jackpotText("Estimated Jackpot");
  const cash = jackpotText("Cash Value");

  const table = html.match(/<table class="winners-table[\s\S]*?<\/table>/i)?.[0];
  if (!table) {
    throw new Error("Powerball draw page is missing its prize table.");
  }
  const tableRows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)]
    .map((match) => match[1])
    .filter((row) => /<td/i.test(row));
  if (tableRows.length !== POWERBALL_PRIZE_TIERS.length) {
    throw new Error("Powerball draw page has an unexpected number of prize tiers.");
  }

  const rows = tableRows.map((row, index) => {
    const [mainMatches, bonusMatches] = POWERBALL_PRIZE_TIERS[index];
    if (game === "powerball") {
      const marker = row.match(/\bitem-powerball\s+m(\d)(-pb)?\b/i);
      if (!marker || Number(marker[1]) !== mainMatches || Boolean(marker[2]) !== bonusMatches) {
        throw new Error("Powerball draw page prize tiers are not in the expected order.");
      }
    }
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => stripTags(cell[1]));
    const expectedCells = game === "powerball" ? 5 : 3;
    if (cells.length !== expectedCells) {
      throw new Error("Powerball draw page prize rows have an unexpected shape.");
    }
    return {
      mainMatches,
      bonusMatches,
      winners: parseCountCell(cells[1], "winner count"),
      prize: parsePrizeCell(cells[2]),
      powerPlayPrize: game === "powerball" ? parsePrizeCell(cells[4]) : null,
    };
  });

  return {
    numbers: { numbers: whiteBalls, bonusNumber: bonusBalls[0] },
    powerPlayMultiplier,
    jackpotEstimate: game === "powerball" && estimate ? parseDisplayedAmount(estimate, "jackpot") : null,
    jackpotCashValue: game === "powerball" && cash ? parseDisplayedAmount(cash, "cash value") : null,
    rows,
  };
}

export function parseMegaMillionsDraw(body: string, drawingDate: string): {
  main: MuslNumberSet;
  jackpot: { estimate: number; cashValue: number; winners: number };
  prizes: Record<string, number>;
} {
  let payload: any;
  try {
    const envelope = JSON.parse(body);
    payload = typeof envelope?.d === "string" ? JSON.parse(envelope.d) : null;
  } catch {
    throw new Error("Mega Millions draw response is not valid JSON.");
  }
  const drawing = payload?.Drawing;
  const jackpot = payload?.Jackpot;
  const tiers = payload?.PrizeMatrix?.PrizeTiers;
  if (!drawing || !jackpot || !Array.isArray(tiers)) {
    throw new Error("Mega Millions draw response is missing drawing, jackpot, or prize matrix data.");
  }
  if (typeof drawing.PlayDate !== "string" || drawing.PlayDate.slice(0, 10) !== drawingDate) {
    throw new Error("Mega Millions draw response is for a different drawing date.");
  }

  const numbers = [drawing.N1, drawing.N2, drawing.N3, drawing.N4, drawing.N5];
  if (
    numbers.some((number) => !Number.isInteger(number) || number < 1 || number > 70) ||
    new Set(numbers).size !== 5 ||
    !Number.isInteger(drawing.MBall) || drawing.MBall < 1 || drawing.MBall > 24
  ) {
    throw new Error("Mega Millions draw response contains invalid winning numbers.");
  }
  const estimate = Number(jackpot.CurrentPrizePool);
  const cashValue = Number(jackpot.CurrentCashValue);
  const winners = jackpot.Winners;
  if (
    jackpot.Verified !== true || !Number.isFinite(estimate) || estimate <= 0 ||
    !Number.isFinite(cashValue) || cashValue <= 0 || !Number.isInteger(winners) || winners < 0
  ) {
    throw new Error("Mega Millions jackpot data is unverified or invalid.");
  }

  const prizes: Record<string, number> = {};
  for (const tier of tiers) {
    if (!Number.isInteger(tier?.TierWhiteBall) || typeof tier?.TierMegaBall !== "boolean") {
      throw new Error("Mega Millions prize matrix has an invalid tier.");
    }
    if (tier.IsJackpot) {
      continue;
    }
    const key = prizeKey(tier.TierWhiteBall, tier.TierMegaBall);
    for (const [column, multiplier] of MEGAPLIER_COLUMNS) {
      const amount = Number(tier[column]);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Mega Millions prize matrix has an invalid multiplier amount.");
      }
      prizes[`${key}_x${multiplier}`] = amount;
    }
  }
  if (Object.keys(prizes).length !== 8 * MEGAPLIER_COLUMNS.length) {
    throw new Error("Mega Millions prize matrix is missing prize tiers.");
  }

  return { main: { numbers, bonusNumber: drawing.MBall }, jackpot: { estimate, cashValue, winners }, prizes };
}

export class MuslDrawSource {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => Date;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    options: { timeoutMs?: number; maxResponseBytes?: number; now?: () => Date } = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  async fetchDraw(lottery: LotteryType, drawingDate: string): Promise<MuslDrawDetail> {
    return lottery === "powerball" ? this.fetchPowerball(drawingDate) : this.fetchMegaMillions(drawingDate);
  }

  private async fetchPowerball(drawingDate: string): Promise<MuslDrawDetail> {
    const pageUrl = (game: string) => {
      const url = new URL("https://www.powerball.com/draw-result");
      url.searchParams.set("gc", game);
      url.searchParams.set("date", drawingDate);
      return url.href;
    };
    const [mainDocument, doublePlayDocument] = await Promise.all([
      this.fetchDocument(pageUrl("powerball"), POWERBALL_HOST, { method: "GET", headers: { Accept: "text/html" } }),
      this.fetchDocument(pageUrl("pb-double-play"), POWERBALL_HOST, { method: "GET", headers: { Accept: "text/html" } }),
    ]);
    const main = parsePowerballDrawPage(mainDocument.body, drawingDate, "powerball");
    const doublePlay = parsePowerballDrawPage(doublePlayDocument.body, drawingDate, "double_play");
    if (main.jackpotEstimate == null || main.jackpotCashValue == null) {
      throw new Error("Powerball draw page is missing its jackpot values.");
    }

    const prizes: Record<string, number> = {};
    for (const row of main.rows) {
      const key = prizeKey(row.mainMatches, row.bonusMatches);
      const isJackpot = row.mainMatches === 5 && row.bonusMatches;
      if (isJackpot) {
        continue;
      }
      if (row.prize == null || row.powerPlayPrize == null) {
        throw new Error("Powerball draw page has a prize tier without an amount.");
      }
      prizes[key] = row.prize;
      prizes[`${key}_power_play`] = row.powerPlayPrize;
    }
    for (const row of doublePlay.rows) {
      if (row.prize == null) {
        throw new Error("Double Play draw page has a prize tier without an amount.");
      }
      prizes[`double_play_${prizeKey(row.mainMatches, row.bonusMatches)}`] = row.prize;
    }

    return {
      lottery: "powerball",
      drawingDate,
      main: main.numbers,
      powerPlayMultiplier: main.powerPlayMultiplier,
      doublePlay: doublePlay.numbers,
      jackpot: { estimate: main.jackpotEstimate, cashValue: main.jackpotCashValue, winners: main.rows[0].winners },
      prizes,
      documents: [mainDocument, doublePlayDocument],
    };
  }

  private async fetchMegaMillions(drawingDate: string): Promise<MuslDrawDetail> {
    const document = await this.fetchDocument(
      "https://www.megamillions.com/cmspages/utilservice.asmx/GetDrawDataByTickWithMatrix",
      MEGA_MILLIONS_HOST,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", Accept: "application/json" },
        body: JSON.stringify({ PlayDateTicks: megaMillionsTicks(drawingDate) }),
      }
    );
    const parsed = parseMegaMillionsDraw(document.body, drawingDate);
    return {
      lottery: "mega_millions",
      drawingDate,
      main: parsed.main,
      powerPlayMultiplier: null,
      doublePlay: null,
      jackpot: parsed.jackpot,
      prizes: parsed.prizes,
      documents: [document],
    };
  }

  private async fetchDocument(url: string, expectedHost: string, init: RequestInit): Promise<OfficialSourceDocument> {
    const response = await this.fetcher(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) {
      throw new Error(`Multi-State Lottery request failed with HTTP ${response.status}.`);
    }
    const finalUrl = response.url || url;
    if (new URL(finalUrl).hostname !== expectedHost) {
      throw new Error("Multi-State Lottery response redirected outside its source host.");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      throw new Error("Multi-State Lottery response exceeds the configured size limit.");
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > this.maxResponseBytes) {
      throw new Error("Multi-State Lottery response exceeds the configured size limit.");
    }
    return {
      url: finalUrl,
      contentType: response.headers.get("content-type"),
      body,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      fetchedAt: this.now().toISOString(),
    };
  }
}
