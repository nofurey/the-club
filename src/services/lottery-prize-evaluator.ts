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
import { isMegaplierValue, POWERBALL_PRIZE_TIERS } from "./ticket-options";

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
    if (winningNumbers.doublePlay != null) {
      this.parseNumberSet(winningNumbers.doublePlay, rules.numberRules, "Official Double Play numbers");
    }
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
    const jackpotWins: EvaluatedPrize[] = [];
    const doublePlayNumbers = drawing.lottery === "powerball" && result.officialWinningNumbers?.doublePlay != null
      ? this.parseNumberSet(result.officialWinningNumbers.doublePlay, rules.numberRules, "Official Double Play numbers")
      : null;
    for (const contribution of drawingContributions) {
      for (const rawNumberSet of contribution.numberSets) {
        const numberSet = this.parseNumberSet(rawNumberSet, rules.numberRules, "Ticket number set");
        const options = this.readPlayOptions(rawNumberSet, drawing.lottery);
        const tier = this.findTier(rules.prizeTiers, numberSet, winningNumbers);

        if (tier) {
          const win = { contributionId: contribution.id, userId: contribution.userId, prizeType: tier.prizeType, amount: 0 };
          if (tier.prizeAmount === "jackpot_estimate") {
            jackpotWins.push(win);
            wins.push(win);
          } else {
            const optionKey = this.optionPrizeKey(tier, options, drawing.lottery);
            win.prizeType = optionKey ?? tier.prizeType;
            win.amount = optionKey ? this.readBreakdownAmount(result, optionKey) : this.resolvePrizeAmount(tier, result);
            wins.push(win);
          }
        }

        if (options.doublePlay) {
          if (!doublePlayNumbers) {
            throw new Error("Official result is missing the Double Play numbers.");
          }
          const dpTier = POWERBALL_PRIZE_TIERS.find(([mainMatches, bonusMatches]) =>
            mainMatches === this.countMainMatches(numberSet, doublePlayNumbers) &&
            bonusMatches === (numberSet.bonusNumber === doublePlayNumbers.bonusNumber));
          if (dpTier) {
            const prizeType = `double_play_match_${dpTier[0]}_bonus_${dpTier[1]}`;
            wins.push({ contributionId: contribution.id, userId: contribution.userId, prizeType, amount: this.readBreakdownAmount(result, prizeType) });
          }
        }
      }
    }

    if (jackpotWins.length > 0) {
      const estimate = this.resolvePrizeAmount({ mainMatches: 5, bonusMatches: true, prizeType: "jackpot", prizeAmount: "jackpot_estimate" }, result);
      const officialWinners = result.prizeBreakdown?.jackpot_winners;
      if (!Number.isInteger(officialWinners) || (officialWinners as number) < jackpotWins.length) {
        throw new Error("The official jackpot winner count is missing or lower than the club's winning plays; the jackpot cannot be split safely.");
      }
      // Equal split among all official jackpot winners, rounded down to the cent.
      const share = Math.floor((estimate * 100) / (officialWinners as number)) / 100;
      for (const win of jackpotWins) {
        win.amount = share;
      }
    }

    return {
      drawingContributionIds: drawingContributions.map((contribution) => contribution.id),
      wins,
    };
  }

  private findTier(tiers: SnapshotPrizeTier[], numberSet: { numbers: number[]; bonusNumber: number }, winning: { numbers: number[]; bonusNumber: number }): SnapshotPrizeTier | undefined {
    const mainMatches = this.countMainMatches(numberSet, winning);
    const bonusMatches = numberSet.bonusNumber === winning.bonusNumber;
    return tiers.find((candidate) => candidate.mainMatches === mainMatches && candidate.bonusMatches === bonusMatches);
  }

  private countMainMatches(numberSet: { numbers: number[] }, winning: { numbers: number[] }): number {
    return numberSet.numbers.reduce((count, number) => count + (winning.numbers.includes(number) ? 1 : 0), 0);
  }

  private readPlayOptions(rawNumberSet: unknown, lottery: Drawing["lottery"]): { powerPlay: boolean; doublePlay: boolean; megaplier: number | null } {
    const raw = this.isRecord(rawNumberSet) ? rawNumberSet : {};
    const megaplier = raw.megaplier == null ? null : raw.megaplier;
    if (megaplier !== null && !isMegaplierValue(megaplier)) {
      throw new Error("Ticket number set has an invalid Mega Millions multiplier.");
    }
    if ((lottery === "powerball" && megaplier !== null) || (lottery === "mega_millions" && (raw.powerPlay === true || raw.doublePlay === true))) {
      throw new Error("Ticket number set has add-ons that its lottery does not offer.");
    }
    return { powerPlay: raw.powerPlay === true, doublePlay: raw.doublePlay === true, megaplier };
  }

  // Returns the breakdown key for plays whose prize depends on a multiplier add-on.
  private optionPrizeKey(tier: SnapshotPrizeTier, options: { powerPlay: boolean; megaplier: number | null }, lottery: Drawing["lottery"]): string | null {
    if (typeof tier.prizeAmount === "number") {
      return null;
    }
    if (lottery === "mega_millions") {
      if (options.megaplier === null) {
        throw new Error("A winning Mega Millions play is missing its recorded multiplier.");
      }
      return `${tier.prizeType}_x${options.megaplier}`;
    }
    return options.powerPlay ? `${tier.prizeType}_power_play` : null;
  }

  private readBreakdownAmount(result: DrawingResult, key: string): number {
    const amount = this.readNumber(result.prizeBreakdown?.[key], `Prize amount for ${key}`);
    if (amount <= 0) {
      throw new Error(`Prize amount for ${key} must be greater than zero.`);
    }
    return amount;
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
