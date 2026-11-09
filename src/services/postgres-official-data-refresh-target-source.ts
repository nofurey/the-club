import type { OfficialDataRefreshInput } from "./official-lottery-data-service";
import type { OfficialDataRefreshTargetSource } from "./official-data-refresh-job";

export interface OfficialDataRefreshTargetRepository {
  findOfficialDataRefreshTargets(asOfDate: string, lookbackDays: number): Promise<OfficialDataRefreshInput[]>;
}

export class PostgresOfficialDataRefreshTargetSource implements OfficialDataRefreshTargetSource {
  constructor(
    private readonly repository: OfficialDataRefreshTargetRepository,
    private readonly lookbackDays = 30,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!Number.isInteger(lookbackDays) || lookbackDays < 0) {
      throw new Error("Refresh target lookback must be a nonnegative integer.");
    }
  }

  getTargets(): Promise<OfficialDataRefreshInput[]> {
    return this.repository.findOfficialDataRefreshTargets(this.getEasternDate(), this.lookbackDays);
  }

  private getEasternDate(): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(this.now());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
}