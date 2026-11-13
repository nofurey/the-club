import type { LotteryType } from "../domain";

export interface ScheduledDrawingDate {
  lottery: LotteryType;
  drawingDate: string;
  cutoffTimeEt: string;
}

const SCHEDULE: Record<LotteryType, { weekdays: ReadonlySet<number>; cutoffTimeEt: string; maxDrawings: number; drawingIncrement: number }> = {
  powerball: { weekdays: new Set([1, 3, 6]), cutoffTimeEt: "21:58:00", maxDrawings: 30, drawingIncrement: 5 },
  mega_millions: { weekdays: new Set([2, 5]), cutoffTimeEt: "22:45:00", maxDrawings: 26, drawingIncrement: 1 },
};

export function getMaxDrawings(lottery: LotteryType): number {
  return SCHEDULE[lottery].maxDrawings;
}

export function getMaxNumberSets(_lottery: LotteryType): number {
  return 10;
}

export function getDrawingCutoffAtEt(drawingDate: string, cutoffTimeEt: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(drawingDate) || !/^\d{2}:\d{2}:\d{2}$/.test(cutoffTimeEt)) {
    throw new Error("Drawing cutoff must contain a valid date and Eastern time.");
  }
  const wallTimeAsUtc = Date.parse(`${drawingDate}T${cutoffTimeEt}Z`);
  if (!Number.isFinite(wallTimeAsUtc) || new Date(wallTimeAsUtc).toISOString().slice(0, 10) !== drawingDate) {
    throw new Error("Drawing cutoff date is invalid.");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(wallTimeAsUtc));
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const renderedAsUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  return new Date(wallTimeAsUtc - (renderedAsUtc - wallTimeAsUtc)).toISOString();
}

export function isAllowedDrawingCount(lottery: LotteryType, drawingCount: number): boolean {
  return getDrawingCountOptions(lottery, SCHEDULE[lottery].maxDrawings).includes(drawingCount);
}

export function getDrawingCountOptions(lottery: LotteryType, availableCount: number): number[] {
  if (!Number.isInteger(availableCount) || availableCount < 1) return [];
  const { maxDrawings, drawingIncrement } = SCHEDULE[lottery];
  const maximum = Math.min(maxDrawings, availableCount);
  if (drawingIncrement === 1) return Array.from({ length: maximum }, (_, index) => index + 1);
  return [1, ...Array.from({ length: Math.floor(maximum / drawingIncrement) }, (_, index) => (index + 1) * drawingIncrement)];
}

export function getUpcomingDrawingDates(
  lotteries: LotteryType[],
  asOfDate: string,
  countPerLottery = 2,
  lookaheadDays = 21
): ScheduledDrawingDate[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || new Date(`${asOfDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== asOfDate) {
    throw new Error("Drawing schedule date must be a valid YYYY-MM-DD date.");
  }
  if (!Number.isInteger(countPerLottery) || countPerLottery < 1 || !Number.isInteger(lookaheadDays) || lookaheadDays < 0) {
    throw new Error("Drawing schedule limits must be nonnegative integers, with at least one drawing.");
  }

  const result: ScheduledDrawingDate[] = [];
  const start = new Date(`${asOfDate}T00:00:00.000Z`);
  for (const lottery of [...new Set(lotteries)]) {
    const config = SCHEDULE[lottery];
    let found = 0;
    for (let offset = 0; offset <= lookaheadDays && found < countPerLottery; offset++) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + offset);
      if (!config.weekdays.has(date.getUTCDay())) continue;
      result.push({ lottery, drawingDate: date.toISOString().slice(0, 10), cutoffTimeEt: config.cutoffTimeEt });
      found++;
    }
    if (found < countPerLottery) throw new Error(`Could not find enough upcoming ${lottery} drawings in the configured lookahead.`);
  }
  return result.sort((left, right) => left.drawingDate.localeCompare(right.drawingDate) || left.lottery.localeCompare(right.lottery));
}