import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { Drawing } from "../domain";
import { MuslDrawSource, megaMillionsTicks, parseMegaMillionsDraw, parsePowerballDrawPage } from "./musl-draw-source";
import { MuslVerifiedLotteryProvider } from "./musl-verified-lottery-provider";
import type { OfficialLotteryProvider } from "./official-lottery-data-service";

const fixture = (name: string) => readFileSync(path.resolve(__dirname, "fixtures", name), "utf8");
const powerballPage = fixture("powerball-draw-2026-11-11.html");
const doublePlayPage = fixture("double-play-draw-2026-11-11.html");
const sharedJackpotPage = fixture("powerball-draw-2025-09-06.html");
const megaMillionsBody = fixture("mega-millions-draw-2026-11-10.json");

test("parses Powerball numbers, Power Play multiplier, jackpot, and both prize columns", () => {
  const page = parsePowerballDrawPage(powerballPage, "2026-11-11", "powerball");

  assert.deepEqual(page.numbers, { numbers: [8, 42, 45, 51, 57], bonusNumber: 17 });
  assert.equal(page.powerPlayMultiplier, 3);
  assert.equal(page.jackpotEstimate, 45000000);
  assert.equal(page.jackpotCashValue, 19400000);
  assert.deepEqual(page.rows[0], { mainMatches: 5, bonusMatches: true, winners: 0, prize: null, powerPlayPrize: null });
  assert.deepEqual(page.rows[1], { mainMatches: 5, bonusMatches: false, winners: 0, prize: 1000000, powerPlayPrize: 2000000 });
  assert.deepEqual(page.rows[2], { mainMatches: 4, bonusMatches: true, winners: 2, prize: 50000, powerPlayPrize: 150000 });
  assert.deepEqual(page.rows[8], { mainMatches: 0, bonusMatches: true, winners: 166596, prize: 4, powerPlayPrize: 12 });
});

test("parses the separately drawn Double Play numbers and fixed prizes", () => {
  const page = parsePowerballDrawPage(doublePlayPage, "2026-11-11", "double_play");

  assert.deepEqual(page.numbers, { numbers: [15, 27, 45, 52, 55], bonusNumber: 1 });
  assert.equal(page.powerPlayMultiplier, null);
  assert.deepEqual(page.rows.map((row) => row.prize), [10000000, 500000, 50000, 500, 500, 20, 20, 10, 7]);
});

test("reads the official jackpot winner count from a shared-jackpot draw", () => {
  const page = parsePowerballDrawPage(sharedJackpotPage, "2025-09-06", "powerball");

  assert.equal(page.rows[0].winners, 2);
  assert.equal(page.jackpotEstimate, 1790000000);
  assert.equal(page.jackpotCashValue, 820600000);
});

test("rejects Powerball pages for a different date or with a reordered prize table", () => {
  assert.throws(() => parsePowerballDrawPage(powerballPage, "2026-11-09", "powerball"), /different drawing date/i);
  const reordered = powerballPage.replace("item-powerball m5-pb", "item-powerball m4-pb");
  assert.throws(() => parsePowerballDrawPage(reordered, "2026-11-11", "powerball"), /not in the expected order/i);
});

test("parses Mega Millions numbers, jackpot, and per-multiplier prize amounts", () => {
  const draw = parseMegaMillionsDraw(megaMillionsBody, "2026-11-10");

  assert.deepEqual(draw.main, { numbers: [2, 18, 25, 30, 65], bonusNumber: 22 });
  assert.deepEqual(draw.jackpot, { estimate: 529000000, cashValue: 224200000, winners: 0 });
  assert.equal(draw.prizes.match_5_bonus_false_x2, 2000000);
  assert.equal(draw.prizes.match_5_bonus_false_x10, 10000000);
  assert.equal(draw.prizes.match_4_bonus_true_x3, 30000);
  assert.equal(draw.prizes.match_0_bonus_true_x5, 25);
  assert.equal(Object.keys(draw.prizes).length, 40);
  assert.throws(() => parseMegaMillionsDraw(megaMillionsBody, "2026-11-06"), /different drawing date/i);
});

test("converts drawing dates to Mega Millions .NET ticks", () => {
  assert.equal(megaMillionsTicks("2026-11-10"), "639298656000000000");
});

const drawing: Drawing = {
  id: "drawing-1",
  lottery: "powerball",
  drawingDate: "2026-11-11",
  state: "MI",
  cutoffTimeEt: "21:58:00",
  officialResultPostedAt: null,
  status: "pending",
  createdAt: "2026-11-01T00:00:00.000Z",
};

const michiganDocument = { url: "https://www.michiganlottery.com/api", contentType: "application/json", body: "{}", sha256: "a".repeat(64), fetchedAt: "2026-11-12T00:00:00.000Z" };

function baseProvider(numbers: { numbers: number[]; bonusNumber: number } | null): OfficialLotteryProvider {
  return {
    fetchRules: async () => { throw new Error("not used"); },
    fetchResult: async () => ({
      document: michiganDocument,
      result: numbers && { winningNumbers: numbers, jackpotEstimate: null, prizeBreakdown: {}, postedAt: null },
    }),
  };
}

function pageFetcher(requests: string[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method} ${url.pathname}${url.search}`);
    const body = url.searchParams.get("gc") === "pb-double-play" ? doublePlayPage : powerballPage;
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  };
}

test("merges Power Play, Double Play, prizes, and jackpot winners into the verified Powerball result", async () => {
  const requests: string[] = [];
  const provider = new MuslVerifiedLotteryProvider(
    baseProvider({ numbers: [51, 8, 42, 45, 57], bonusNumber: 17 }),
    new MuslDrawSource(pageFetcher(requests), { now: () => new Date("2026-11-12T03:00:00.000Z") })
  );

  const { result, document } = await provider.fetchResult(drawing);

  assert.deepEqual(requests.sort(), [
    "GET /draw-result?gc=pb-double-play&date=2026-11-11",
    "GET /draw-result?gc=powerball&date=2026-11-11",
  ]);
  assert.equal(result?.winningNumbers.powerPlayMultiplier, 3);
  assert.deepEqual(result?.winningNumbers.doublePlay, { numbers: [15, 27, 45, 52, 55], bonusNumber: 1 });
  assert.equal(result?.jackpotEstimate, 45000000);
  assert.equal(result?.prizeBreakdown?.jackpot_winners, 0);
  assert.equal(result?.prizeBreakdown?.jackpot_cash_value, 19400000);
  assert.equal(result?.prizeBreakdown?.match_4_bonus_true, 50000);
  assert.equal(result?.prizeBreakdown?.match_4_bonus_true_power_play, 150000);
  assert.equal(result?.prizeBreakdown?.double_play_match_5_bonus_false, 500000);
  const sources = JSON.parse(document.body).sources as Array<{ url: string }>;
  assert.deepEqual(sources.map((source) => new URL(source.url).hostname), ["www.michiganlottery.com", "www.powerball.com", "www.powerball.com"]);
});

test("fails when Michigan and the Multi-State Lottery disagree on the winning numbers", async () => {
  const provider = new MuslVerifiedLotteryProvider(
    baseProvider({ numbers: [1, 2, 3, 4, 5], bonusNumber: 17 }),
    new MuslDrawSource(pageFetcher([]))
  );
  await assert.rejects(() => provider.fetchResult(drawing), /do not match/i);
});

test("does not call the Multi-State Lottery while results are pending", async () => {
  const requests: string[] = [];
  const provider = new MuslVerifiedLotteryProvider(baseProvider(null), new MuslDrawSource(pageFetcher(requests)));

  assert.equal((await provider.fetchResult(drawing)).result, null);
  assert.deepEqual(requests, []);
});

test("posts the drawing's ticks to the Mega Millions matrix endpoint", async () => {
  let request: { url: string; body: unknown } | undefined;
  const provider = new MuslVerifiedLotteryProvider(
    baseProvider({ numbers: [2, 18, 25, 30, 65], bonusNumber: 22 }),
    new MuslDrawSource(async (input, init) => {
      request = { url: String(input), body: JSON.parse(String(init?.body)) };
      return new Response(megaMillionsBody, { status: 200, headers: { "content-type": "application/json" } });
    })
  );

  const { result } = await provider.fetchResult({ ...drawing, lottery: "mega_millions", drawingDate: "2026-11-10" });

  assert.equal(request?.url, "https://www.megamillions.com/cmspages/utilservice.asmx/GetDrawDataByTickWithMatrix");
  assert.deepEqual(request?.body, { PlayDateTicks: "639298656000000000" });
  assert.equal(result?.jackpotEstimate, 529000000);
  assert.equal(result?.prizeBreakdown?.match_4_bonus_true_x4, 40000);
  assert.equal(result?.winningNumbers.powerPlayMultiplier, undefined);
});
