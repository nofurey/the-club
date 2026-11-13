import type { OfficialDataRepository } from "./official-lottery-data-service";
import { OfficialLotteryDataService } from "./official-lottery-data-service";
import { OfficialDataRefreshJob, type OfficialDataRefreshJobOptions } from "./official-data-refresh-job";
import { MichiganLotteryGraphqlProvider } from "./michigan-lottery-graphql-provider";
import { MuslVerifiedLotteryProvider } from "./musl-verified-lottery-provider";
import { DrawingCalculationService } from "./drawing-calculation-service";
import type { DrawingCalculationRepository } from "./drawing-calculation-service";
import { SnapshotLotteryPrizeEvaluator } from "./lottery-prize-evaluator";
import { OfficialDataCalculationRefreshService } from "./official-data-calculation-refresh";
import {
  PostgresOfficialDataRefreshTargetSource,
  type OfficialDataRefreshTargetRepository,
} from "./postgres-official-data-refresh-target-source";

export type OfficialDataRefreshRuntimeRepository = OfficialDataRepository & OfficialDataRefreshTargetRepository & DrawingCalculationRepository;

export function createMichiganPostgresOfficialDataRefreshJob(
  repository: OfficialDataRefreshRuntimeRepository,
  options: OfficialDataRefreshJobOptions = {}
): OfficialDataRefreshJob {
  const provider = new MuslVerifiedLotteryProvider(new MichiganLotteryGraphqlProvider());
  const officialData = new OfficialLotteryDataService(repository, provider);
  const calculator = new DrawingCalculationService(repository, new SnapshotLotteryPrizeEvaluator());
  const refreshService = new OfficialDataCalculationRefreshService(officialData, repository, calculator);
  const targetSource = new PostgresOfficialDataRefreshTargetSource(repository);
  return new OfficialDataRefreshJob(targetSource, refreshService, options);
}