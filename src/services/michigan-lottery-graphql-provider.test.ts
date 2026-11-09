import assert from "node:assert/strict";
import test from "node:test";

import type { Drawing } from "../domain";
import { MichiganLotteryGraphqlProvider } from "./michigan-lottery-graphql-provider";

const drawing: Drawing = {
  id: "drawing-1",
  lottery: "powerball",
  drawingDate: "2026-11-07",
  state: "MI",
  cutoffTimeEt: "21:58:00",
  officialResultPostedAt: null,
  status: "pending",
  createdAt: "2026-11-01T00:00:00.000Z",
};

const gameDetails = [
  { title: "Game Details", body: "<strong>Ticket Cost:</strong> $2.00" },
  {
    title: "Prize Table",
    body: `<table>
      <tr><td>5 White Balls + Powerball</td><td>1 in 292,201,338</td><td>Jackpot*</td></tr>
      <tr><td>5 White Balls</td><td>1 in 11,688,054</td><td>$1 Million</td></tr>
      <tr><td>4 White Balls + Powerball</td><td>1 in 913,130</td><td>$50,000</td></tr>
      <tr><td>Powerball</td><td>1 in 39</td><td>$4</td></tr>
    </table>`,
  },
  {
    title: "How to Play",
    body: "Choose 5 white ball numbers from 1 to 69 and 1 red Powerball number from 1 to 26.",
  },
];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("fetches and normalizes Powerball rules and result data from Michigan GraphQL", async () => {
  const requests: Array<{ body: any; headers: Headers }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    requests.push({ body, headers });

    if (body.operationName === "MichiganGameDetails") {
      return jsonResponse({ data: { getGameDetailPagesByIdentifier: gameDetails } });
    }

    return jsonResponse({
      data: {
        winningNumbers: {
          resultsPending: false,
          drawNumbers: [3, 36, 37, 56, 61],
          powerball: 21,
          megaball: null,
          megaplier: null,
        },
        payout: {
          resultsPending: false,
          payoutGeneric: [
            { prizeLevel: "1", winnerCount: 1, prizeAmount: "$1,000,000", description: "5 White Balls" },
            { prizeLevel: "2", winnerCount: 1, prizeAmount: "$10,000,000", description: "5 White Balls + Powerball" },
          ],
        },
      },
    });
  };
  const provider = new MichiganLotteryGraphqlProvider(fetcher, { now: () => new Date("2026-11-08T03:00:00.000Z") });

  const rules = await provider.fetchRules("powerball");
  const result = await provider.fetchResult(drawing);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.operationName, "MichiganGameDetails");
  assert.equal(requests[0].headers.get("apollo-require-preflight"), "true");
  assert.equal(rules.rules.sourceUrl, "https://www.michiganlottery.com/games/powerball");
  assert.deepEqual(rules.rules.priceSnapshot.numberRules, {
    mainNumberCount: 5,
    mainNumberMin: 1,
    mainNumberMax: 69,
    bonusNumberMin: 1,
    bonusNumberMax: 26,
  });
  assert.equal(rules.rules.priceSnapshot.ticketPrice, 2);
  assert.equal((rules.rules.priceSnapshot.prizeTiers as any[]).length, 4);
  assert.deepEqual(result.result?.winningNumbers, { numbers: [3, 36, 37, 56, 61], bonusNumber: 21 });
  assert.deepEqual(result.result?.prizeBreakdown, {
    match_5_bonus_false: 1000000,
    match_5_bonus_true: 10000000,
  });
  assert.equal(result.result?.jackpotEstimate, 10000000);
  assert.equal(result.document.url, "https://www.michiganlottery.com/api");
});

test("normalizes Mega Millions bonus number and returns pending draws as no result", async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.operationName === "MichiganGameDetails") {
      return jsonResponse({
        data: {
          getGameDetailPagesByIdentifier: [
            { title: "Game Details", body: "Ticket Cost: $5.00" },
            { title: "Prize Table", body: "<table><tr><td>5 White Balls + Mega Ball</td><td>1 in 290,472,336</td><td>Jackpot*</td></tr></table>" },
            { title: "How to Play", body: "Choose 5 white ball numbers from 1 to 70 and 1 gold Mega Ball number from 1 to 24." },
          ],
        },
      });
    }
    return jsonResponse({
      data: {
        winningNumbers: { resultsPending: true, drawNumbers: null, megaball: null, powerball: null },
        payout: { resultsPending: true, payoutGeneric: [] },
      },
    });
  };
  const provider = new MichiganLotteryGraphqlProvider(fetcher);
  const megaDrawing = { ...drawing, lottery: "mega_millions" as const };

  const rules = await provider.fetchRules("mega_millions");
  const result = await provider.fetchResult(megaDrawing);

  assert.equal(rules.rules.priceSnapshot.ticketPrice, 5);
  assert.equal((rules.rules.priceSnapshot.numberRules as any).mainNumberMax, 70);
  assert.equal((rules.rules.priceSnapshot.numberRules as any).bonusNumberMax, 24);
  assert.equal(result.result, null);
});
