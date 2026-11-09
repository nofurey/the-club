import type { OfficialDataRefreshInput } from "./official-lottery-data-service";

export interface OfficialDataRefreshTargetSource {
  getTargets(): Promise<OfficialDataRefreshInput[]>;
}

export interface OfficialDataRefreshService {
  refreshDrawing(input: OfficialDataRefreshInput): Promise<unknown>;
}

export interface RefreshJobFailure {
  target: OfficialDataRefreshInput;
  attempts: number;
  error: string;
}

export interface RefreshJobSummary {
  startedAt: string;
  finishedAt: string;
  targetCount: number;
  succeeded: number;
  failures: RefreshJobFailure[];
}

export type RefreshJobEvent =
  | { type: "run_started"; at: string }
  | { type: "target_succeeded"; target: OfficialDataRefreshInput; attempts: number }
  | { type: "target_failed"; failure: RefreshJobFailure }
  | { type: "run_completed"; summary: RefreshJobSummary }
  | { type: "run_failed"; at: string; error: string };

export interface RefreshTimerDriver {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface OfficialDataRefreshJobOptions {
  intervalMs?: number;
  minTargetIntervalMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  now?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
  onEvent?: (event: RefreshJobEvent) => void;
  timerDriver?: RefreshTimerDriver;
}

const systemTimerDriver: RefreshTimerDriver = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class OfficialDataRefreshJob {
  private readonly intervalMs: number;
  private readonly minTargetIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly now: () => Date;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly onEvent?: (event: RefreshJobEvent) => void;
  private readonly timerDriver: RefreshTimerDriver;
  private activeRun: Promise<RefreshJobSummary> | null = null;
  private timerHandle: unknown = null;
  private lastTargetStartedAt: number | null = null;

  constructor(
    private readonly targets: OfficialDataRefreshTargetSource,
    private readonly service: OfficialDataRefreshService,
    options: OfficialDataRefreshJobOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
    this.minTargetIntervalMs = options.minTargetIntervalMs ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 30000;
    this.now = options.now ?? (() => new Date());
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onEvent = options.onEvent;
    this.timerDriver = options.timerDriver ?? systemTimerDriver;

    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer.");
    }
    if (this.intervalMs <= 0 || this.minTargetIntervalMs < 0 || this.retryBaseDelayMs < 0 || this.retryMaxDelayMs < 0) {
      throw new Error("Refresh job intervals and retry delays must be valid nonnegative values.");
    }
  }

  runOnce(): Promise<RefreshJobSummary> {
    if (this.activeRun) {
      return this.activeRun;
    }

    this.activeRun = this.execute().finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  start(): void {
    if (this.timerHandle !== null) {
      throw new Error("Official data refresh job is already running.");
    }
    this.timerHandle = this.timerDriver.setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timerHandle === null) {
      return;
    }
    this.timerDriver.clearInterval(this.timerHandle);
    this.timerHandle = null;
  }

  private async execute(): Promise<RefreshJobSummary> {
    const startedAt = this.now().toISOString();
    this.emit({ type: "run_started", at: startedAt });

    let targets: OfficialDataRefreshInput[];
    try {
      targets = await this.getUniqueTargets();
    } catch (error) {
      this.emit({ type: "run_failed", at: this.now().toISOString(), error: this.errorMessage(error) });
      throw error;
    }

    const failures: RefreshJobFailure[] = [];
    let succeeded = 0;

    for (const target of targets) {
      const failure = await this.refreshTarget(target);
      if (failure) {
        failures.push(failure);
      } else {
        succeeded += 1;
      }
    }

    const summary: RefreshJobSummary = {
      startedAt,
      finishedAt: this.now().toISOString(),
      targetCount: targets.length,
      succeeded,
      failures,
    };
    this.emit({ type: "run_completed", summary });
    return summary;
  }

  private async getUniqueTargets(): Promise<OfficialDataRefreshInput[]> {
    const targets = await this.targets.getTargets();
    const unique = new Map<string, OfficialDataRefreshInput>();
    for (const target of targets) {
      if (!target.drawingId || !target.clubId) {
        throw new Error("Refresh targets must include drawingId and clubId.");
      }
      unique.set(`${target.drawingId}:${target.clubId}`, target);
    }
    return [...unique.values()];
  }

  private async refreshTarget(target: OfficialDataRefreshInput): Promise<RefreshJobFailure | null> {
    let attempts = 0;
    while (attempts < this.maxAttempts) {
      await this.enforceTargetSpacing();
      attempts += 1;
      try {
        await this.service.refreshDrawing(target);
        this.emit({ type: "target_succeeded", target, attempts });
        return null;
      } catch (error) {
        if (attempts < this.maxAttempts) {
          const backoffMs = Math.min(this.retryBaseDelayMs * 2 ** (attempts - 1), this.retryMaxDelayMs);
          if (backoffMs > 0) {
            await this.delay(backoffMs);
          }
          continue;
        }

        const failure: RefreshJobFailure = {
          target,
          attempts,
          error: this.errorMessage(error),
        };
        this.emit({ type: "target_failed", failure });
        return failure;
      }
    }
    return null;
  }

  private async enforceTargetSpacing(): Promise<void> {
    if (this.lastTargetStartedAt !== null && this.minTargetIntervalMs > 0) {
      const elapsedMs = this.now().getTime() - this.lastTargetStartedAt;
      const waitMs = Math.max(0, this.minTargetIntervalMs - elapsedMs);
      if (waitMs > 0) {
        await this.delay(waitMs);
      }
    }
    this.lastTargetStartedAt = this.now().getTime();
  }

  private emit(event: RefreshJobEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Monitoring callbacks must not interrupt refreshes.
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
