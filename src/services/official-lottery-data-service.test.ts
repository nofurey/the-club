import assert from "node:assert/strict";
import test from "node:test";

import type { CalculationSnapshot, Drawing, DrawingResult, DrawingSizeSnapshot } from "../domain";
import {
  HttpOfficialLotteryProvider,
  OfficialLotteryDataService,
  type OfficialDataRepository,
  type OfficialLotterySourceDefinition,
} from "./official-lottery-data-service";

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

const rulesPayload = {
  version: "2026-11-01",
  priceSnapshot: {
    ticketPrice: 2,
    numberRules: {
      mainNumberCount: 5,
      mainNumberMin: 1,
      mainNumberMax: 69,
      bonusNumberMin: 1,
      bonusNumberMax: 26,
    },
    prizeTiers: [{ mainMatches: 5, bonusMatches: true, prizeType: "jackpot", prizeAmount: "jackpot_estimate" }],
  },
};

const resultPayload = {
  winningNumbers: { numbers: [1, 2, 3, 4, 5], bonusNumber: 6 },
  jackpotEstimate: 100000000,
  prizeBreakdown: { jackpot: 100000000 },
  postedAt: "2026-11-08T03:00:00.000Z",
};

const definition: OfficialLotterySourceDefinition = {
  rulesUrl: "https://data.michigan.example/powerball/rules.json",
  resultsUrl: "https://data.michigan.example/powerball/results/2026-11-07.json",
  allowedHosts: ["data.michigan.example"],
};

class TestOfficialDataRepository implements OfficialDataRepository {
  readonly saved: Array<{ snapshot: CalculationSnapshot; result: DrawingResult; drawingSize: DrawingSizeSnapshot | null }> = [];

  async findDrawingById(drawingId: string) {
    return drawingId === drawing.id ? drawing : null;
  }

  async storeOfficialData(
    snapshot: CalculationSnapshot,
    result: DrawingResult,
    _officialResultPostedAt: string | null,
    drawingSize: DrawingSizeSnapshot | null
  ) {
    this.saved.push({ snapshot, result, drawingSize });
    return { snapshot, result, rulesChanged: true, resultChanged: true, drawingSizeUpdated: drawingSize !== null };
  }
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test("fetches official documents, validates parsed data, and stores raw and normalized snapshots", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === definition.rulesUrl) {
      return response(rulesPayload);
    }
    if (url === definition.resultsUrl) {
      return response(resultPayload);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const httpProvider = new HttpOfficialLotteryProvider({ powerball: definition }, fetcher);
  const provider = {
    fetchRules: (lottery: "powerball" | "mega_millions") => httpProvider.fetchRules(lottery),
    fetchResult: (targetDrawing: Drawing) => httpProvider.fetchResult(targetDrawing),
    async fetchDrawingSize(targetDrawing: Drawing) {
      return {
        document: {
          url: "https://www.powerball.com/v1/gameapi/next-drawing?gamecode=powerball&language=en",
          contentType: "text/html",
          body: "official jackpot response",
          sha256: "c".repeat(64),
          fetchedAt: "2026-11-08T03:00:00.000Z",
        },
        size: {
          drawingDate: targetDrawing.drawingDate,
          estimatedJackpot: 30000000,
          cashValue: 12900000,
        },
      };
    },
  };
  const repository = new TestOfficialDataRepository();
  const service = new OfficialLotteryDataService(repository, provider);

  const saved = await service.refreshDrawing({ drawingId: drawing.id, clubId: "club-1" });

  assert.equal(repository.saved.length, 1);
  assert.equal(saved.snapshot.rulesVersion, rulesPayload.version);
  assert.equal(saved.snapshot.rulesUrl, definition.rulesUrl);
  assert.equal(saved.snapshot.sourceDocumentUrl, definition.rulesUrl);
  assert.equal(saved.snapshot.priceSnapshot.ticketPrice, 2);
  assert.equal(saved.snapshot.sourceContentType, "application/json; charset=utf-8");
  assert.match(saved.snapshot.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(saved.snapshot.sourceDocument, JSON.stringify(rulesPayload));
  assert.equal(saved.result.status, "results_posted");
  assert.deepEqual(saved.result.officialWinningNumbers, resultPayload.winningNumbers);
  assert.equal(saved.result.jackpotEstimate, resultPayload.jackpotEstimate);
  assert.equal(saved.result.officialSourceUrl, definition.resultsUrl);
  assert.equal(saved.result.officialSourceDocument, JSON.stringify(resultPayload));
  assert.equal(saved.result.sourceSnapshotId, saved.snapshot.id);
  assert.equal(repository.saved[0].drawingSize?.estimatedJackpot, 30000000);
  assert.equal(repository.saved[0].drawingSize?.cashValue, 12900000);
  assert.equal(repository.saved[0].drawingSize?.sourceSha256, "c".repeat(64));
  assert.equal(saved.drawingSizeUpdated, true);
});

test("rejects redirects outside the configured official host allowlist", async () => {
  const fetcher: typeof fetch = async () => new Response("redirected", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const provider = new HttpOfficialLotteryProvider(
    { powerball: definition },
    fetcher,
    { responseUrl: () => "https://unexpected.example/data.json" }
  );

  await assert.rejects(() => provider.fetchRules("powerball"), /outside the configured host allowlist/i);
});
