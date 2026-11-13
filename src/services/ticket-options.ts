import type { LotteryType } from "../domain";

export const MEGAPLIER_VALUES = [2, 3, 4, 5, 10] as const;
export type MegaplierValue = (typeof MEGAPLIER_VALUES)[number];

// Michigan Lottery: Power Play and Double Play each add $1 per play per drawing; Mega Millions' multiplier is included in its $5 price.
export const POWERBALL_ADD_ON_PRICE = 1;

export interface PlayOptions {
  powerPlay?: boolean;
  doublePlay?: boolean;
  megaplier?: number;
}

// Powerball and Double Play prize tables list tiers in this fixed order.
export const POWERBALL_PRIZE_TIERS: Array<[mainMatches: number, bonusMatches: boolean]> = [
  [5, true], [5, false], [4, true], [4, false], [3, true], [3, false], [2, true], [1, true], [0, true],
];

export function isMegaplierValue(value: unknown): value is MegaplierValue {
  return typeof value === "number" && (MEGAPLIER_VALUES as readonly number[]).includes(value);
}

export function hasValidPlayOptions(lottery: LotteryType, play: PlayOptions): boolean {
  if (
    (play.powerPlay !== undefined && typeof play.powerPlay !== "boolean") ||
    (play.doublePlay !== undefined && typeof play.doublePlay !== "boolean")
  ) {
    return false;
  }
  if (lottery === "powerball") {
    return play.megaplier === undefined;
  }
  return !play.powerPlay && !play.doublePlay && isMegaplierValue(play.megaplier);
}

export function playCostPerDrawing(lottery: LotteryType, ticketPrice: number, play: PlayOptions): number {
  if (lottery !== "powerball") {
    return ticketPrice;
  }
  return ticketPrice + (play.powerPlay ? POWERBALL_ADD_ON_PRICE : 0) + (play.doublePlay ? POWERBALL_ADD_ON_PRICE : 0);
}

export function contributionCost(lottery: LotteryType, ticketPrice: number, drawingCount: number, plays: PlayOptions[]): number {
  const perDrawing = plays.reduce((total, play) => total + playCostPerDrawing(lottery, ticketPrice, play), 0);
  return perDrawing * drawingCount;
}

export function storedPlayOptions(play: PlayOptions): PlayOptions {
  const options: PlayOptions = {};
  if (play.powerPlay) options.powerPlay = true;
  if (play.doublePlay) options.doublePlay = true;
  if (play.megaplier !== undefined) options.megaplier = play.megaplier;
  return options;
}
