import { createHash } from "node:crypto";

import type { Drawing } from "../domain";
import type {
  FetchedOfficialResult,
  FetchedOfficialRules,
  OfficialLotteryProvider,
  OfficialSourceDocument,
} from "./official-lottery-data-service";
import { MuslDrawSource, type MuslDrawDetail } from "./musl-draw-source";

function sameNumbers(left: { numbers: number[]; bonusNumber: unknown }, right: { numbers: number[]; bonusNumber: number }): boolean {
  const sorted = (values: number[]) => [...values].sort((a, b) => a - b).join(",");
  return sorted(left.numbers) === sorted(right.numbers) && Number(left.bonusNumber) === right.bonusNumber;
}

export class MuslVerifiedLotteryProvider implements OfficialLotteryProvider {
  constructor(
    private readonly base: OfficialLotteryProvider,
    private readonly musl: MuslDrawSource = new MuslDrawSource()
  ) {}

  fetchRules(lottery: Parameters<OfficialLotteryProvider["fetchRules"]>[0]): Promise<FetchedOfficialRules> {
    return this.base.fetchRules(lottery);
  }

  async fetchResult(drawing: Drawing): Promise<FetchedOfficialResult> {
    const fetched = await this.base.fetchResult(drawing);
    if (!fetched.result) {
      return fetched;
    }

    const detail = await this.musl.fetchDraw(drawing.lottery, drawing.drawingDate);
    const published = fetched.result.winningNumbers as { numbers: number[]; bonusNumber: unknown };
    if (!sameNumbers(published, detail.main)) {
      throw new Error("Michigan Lottery and Multi-State Lottery winning numbers do not match.");
    }

    const winningNumbers: Record<string, unknown> = { ...fetched.result.winningNumbers };
    if (detail.powerPlayMultiplier != null) {
      winningNumbers.powerPlayMultiplier = detail.powerPlayMultiplier;
    }
    if (detail.doublePlay) {
      winningNumbers.doublePlay = detail.doublePlay;
    }

    return {
      document: this.combineDocuments(fetched.document, detail),
      result: {
        ...fetched.result,
        winningNumbers,
        jackpotEstimate: detail.jackpot.estimate,
        prizeBreakdown: {
          ...detail.prizes,
          jackpot_winners: detail.jackpot.winners,
          jackpot_cash_value: detail.jackpot.cashValue,
        },
      },
    };
  }

  fetchDrawingSize(drawing: Drawing): ReturnType<NonNullable<OfficialLotteryProvider["fetchDrawingSize"]>> {
    return this.base.fetchDrawingSize ? this.base.fetchDrawingSize(drawing) : Promise.resolve(null);
  }

  private combineDocuments(primary: OfficialSourceDocument, detail: MuslDrawDetail): OfficialSourceDocument {
    const sources = [primary, ...detail.documents].map(({ url, contentType, fetchedAt, sha256, body }) => ({
      url, contentType, fetchedAt, sha256, body,
    }));
    const body = JSON.stringify({ sources });
    return {
      url: primary.url,
      contentType: "application/json",
      body,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      fetchedAt: [primary, ...detail.documents].map((document) => document.fetchedAt).sort().at(-1)!,
    };
  }
}
