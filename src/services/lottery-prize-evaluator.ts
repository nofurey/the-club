import type {
  CalculationSnapshot,
  Contribution,
  Drawing,
  DrawingResult,
} from "../domain";
import type {
  DrawingEvaluation,
  DrawingPrizeEvaluator,
  EvaluatedPrize,
} from "./drawing-calculation-service";

export interface SnapshotNumberRules {
  mainNumberCount: number;
  mainNumberMin: number;
  mainNumberMax: number;
  bonusNumberMin: number;
  bonusNumberMax: number;
}

export interface SnapshotPrizeTier {
  mainMatches: number;
  bonusMatches: boolean;
  prizeType: string;
  prizeAmount: number | "jackpot_estimate" | "prize_breakdown";
}

export interface SnapshotPrizeRules {
  numberRules: SnapshotNumberRules;
  prizeTiers: SnapshotPrizeTier[];
}

export class SnapshotLotteryPrizeEvaluator implements DrawingPrizeEvaluator {
  validateSnapshot(priceSnapshot: Record<string, unknown>): void {
    this.parsePrizeRules(priceSnapshot);
  }

  validateOfficialNumbers(winningNumbers: Record<string, unknown>, priceSnapshot: Record<string, unknown>): void {
    const rules = this.parsePrizeRules(priceSnapshot);
    this.parseNumberSet(winningNumbers, rules.numberRules, "Official winning numbers");
  }

  async evaluate({ drawing, drawings, result, snapshot, contributions }: {
    drawing: Drawing;
    drawings: Drawing[];
    result: DrawingResult;
    snapshot: CalculationSnapshot;
    contributions: Contribution[];
  }): Promise<DrawingEvaluation> {
    if (snapshot.lottery !== drawing.lottery || snapshot.drawingId !== drawing.id) {
      throw new Error("Prize rules snapshot does not match the drawing.");
    }

    const rules = this.parsePrizeRules(snapshot.priceSnapshot);
    const winningNumbers = this.parseNumberSet(result.officialWinningNumbers, rules.numberRules, "Official winning numbers");
    const schedule = drawings
      .filter((scheduledDrawing) => scheduledDrawing.lottery === drawing.lottery)
      .sort((left, right) => left.drawingDate.localeCompare(right.drawingDate));
    const currentIndex = schedule.findIndex((scheduledDrawing) => scheduledDrawing.id === drawing.id);

    if (currentIndex < 0 || schedule[currentIndex].drawingDate !== drawing.drawingDate) {
      throw new Error("Drawing schedule does not contain the drawing being calculated.");
    }

    const drawingContributions = contributions.filter((contribution) => {
      if (
        contribution.lottery !== drawing.lottery ||
        contribution.status === "draft" ||
        contribution.status === "archived" ||
        contribution.drawingDate > drawing.drawingDate
      ) {
        return false;
      }

      const startIndex = schedule.findIndex((scheduledDrawing) => scheduledDrawing.drawingDate === contribution.drawingDate);
      if (startIndex < 0) {
        throw new Error("Drawing schedule is missing a contribution's start drawing.");
      }
      return currentIndex >= startIndex && currentIndex < startIndex + contribution.drawingCount;
    });

    const wins: EvaluatedPrize[] = [];
    for (const contribution of drawingContributions) {
      for (const rawNumberSet of contribution.numberSets) {
        const numberSet = this.parseNumberSet(rawNumberSet, rules.numberRules, "Ticket number set");
        const mainMatches = numberSet.numbers.reduce(
          (count, number) => count + (winningNumbers.numbers.includes(number) ? 1 : 0),
          0
        );
        const bonusMatches = numberSet.bonusNumber === winningNumbers.bonusNumber;
        const tier = rules.prizeTiers.find(
          (candidate) => candidate.mainMatches === mainMatches && candidate.bonusMatches === bonusMatches
        );

        if (!tier) {
          continue;
        }

        wins.push({
          contributionId: contribution.id,
          userId: contribution.userId,
          prizeType: tier.prizeType,
          amount: this.resolvePrizeAmount(tier, result),
        });
      }
    }

    return {
      drawingContributionIds: drawingContributions.map((contribution) => contribution.id),
      wins,
    };
  }

  private parsePrizeRules(snapshot: Record<string, unknown>): SnapshotPrizeRules {
    const rawNumberRules = snapshot.numberRules;
    const rawPrizeTiers = snapshot.prizeTiers;
    if (!this.isRecord(rawNumberRules) || !Array.isArray(rawPrizeTiers) || rawPrizeTiers.length === 0) {
      throw new Error("Calculation snapshot is missing prize rules.");
    }

    const numberRules = {
      mainNumberCount: this.readInteger(rawNumberRules.mainNumberCount, "mainNumberCount"),
      mainNumberMin: this.readInteger(rawNumberRules.mainNumberMin, "mainNumberMin"),
      mainNumberMax: this.readInteger(rawNumberRules.mainNumberMax, "mainNumberMax"),
      bonusNumberMin: this.readInteger(rawNumberRules.bonusNumberMin, "bonusNumberMin"),
      bonusNumberMax: this.readInteger(rawNumberRules.bonusNumberMax, "bonusNumberMax"),
    };
    if (
      numberRules.mainNumberMin > numberRules.mainNumberMax ||
      numberRules.bonusNumberMin > numberRules.bonusNumberMax ||
      numberRules.mainNumberCount < 1
    ) {
      throw new Error("Calculation snapshot contains invalid number rules.");
    }

    const prizeTiers = rawPrizeTiers.map((rawTier): SnapshotPrizeTier => {
      if (!this.isRecord(rawTier)) {
        throw new Error("Calculation snapshot contains an invalid prize tier.");
      }
      const prizeAmount = rawTier.prizeAmount;
      if (
        typeof rawTier.prizeType !== "string" ||
        !rawTier.prizeType.trim() ||
        typeof rawTier.bonusMatches !== "boolean" ||
        (typeof prizeAmount !== "number" && prizeAmount !== "jackpot_estimate" && prizeAmount !== "prize_breakdown")
      ) {
        throw new Error("Calculation snapshot contains an invalid prize tier.");
      }
      if (typeof prizeAmount === "number" && (!Number.isFinite(prizeAmount) || prizeAmount <= 0)) {
        throw new Error("Calculation snapshot contains an invalid prize amount.");
      }

      const mainMatches = this.readInteger(rawTier.mainMatches, "mainMatches");
      if (mainMatches > numberRules.mainNumberCount) {
        throw new Error("Calculation snapshot contains a prize tier with impossible matches.");
      }

      return {
        mainMatches,
        bonusMatches: rawTier.bonusMatches,
        prizeType: rawTier.prizeType,
        prizeAmount,
      };
    });

    const tierKeys = prizeTiers.map((tier) => `${tier.mainMatches}:${tier.bonusMatches}`);
    if (new Set(tierKeys).size !== tierKeys.length) {
      throw new Error("Calculation snapshot contains duplicate prize tiers.");
    }

    return { numberRules, prizeTiers };
  }

  private parseNumberSet(value: unknown, rules: SnapshotNumberRules, label: string): { numbers: number[]; bonusNumber: number } {
    if (!this.isRecord(value) || !Array.isArray(value.numbers)) {
      throw new Error(`${label} must contain a numbers array and bonus number.`);
    }

    const numbers = value.numbers.map((number) => this.readInteger(number, `${label} main number`));
    const bonusNumber = this.readNumber(value.bonusNumber, `${label} bonus number`);
    if (numbers.length !== rules.mainNumberCount || new Set(numbers).size !== numbers.length) {
      throw new Error(`${label} must contain the configured number of unique main numbers.`);
    }
    if (numbers.some((number) => number < rules.mainNumberMin || number > rules.mainNumberMax)) {
      throw new Error(`${label} contains a main number outside the configured range.`);
    }
    if (bonusNumber < rules.bonusNumberMin || bonusNumber > rules.bonusNumberMax) {
      throw new Error(`${label} contains a bonus number outside the configured range.`);
    }

    return { numbers, bonusNumber };
  }

  private resolvePrizeAmount(tier: SnapshotPrizeTier, result: DrawingResult): number {
    if (typeof tier.prizeAmount === "number") {
      return tier.prizeAmount;
    }

    let amount: unknown;
    if (tier.prizeAmount === "jackpot_estimate") {
      amount = result.jackpotEstimate;
    } else {
      amount = result.prizeBreakdown?.[tier.prizeType];
      if (this.isRecord(amount)) {
        amount = amount.amount;
      }
    }

    const resolved = this.readNumber(amount, `Prize amount for ${tier.prizeType}`);
    if (resolved <= 0) {
      throw new Error(`Prize amount for ${tier.prizeType} must be greater than zero.`);
    }
    return resolved;
  }

  private readNumber(value: unknown, label: string): number {
    const number = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) {
      throw new Error(`${label} must be a valid number.`);
    }
    return number;
  }

  private readInteger(value: unknown, label: string): number {
    const number = this.readNumber(value, label);
    if (!Number.isInteger(number)) {
      throw new Error(`${label} must be an integer.`);
    }
    return number;
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
