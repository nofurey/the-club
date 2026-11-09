import type { OfficialDataRepository } from "./official-lottery-data-service";
import { OfficialLotteryDataService } from "./official-lottery-data-service";
import { OfficialDataRefreshJob, type OfficialDataRefreshJobOptions } from "./official-data-refresh-job";
import { MichiganLotteryGraphqlProvider } from "./michigan-lottery-graphql-provider";
import {
  PostgresOfficialDataRefreshTargetSource,
  type OfficialDataRefreshTargetRepository,
} from "./postgres-official-data-refresh-target-source";

export type OfficialDataRefreshRuntimeRepository = OfficialDataRepository & OfficialDataRefreshTargetRepository;

export function createMichiganPostgresOfficialDataRefreshJob(
  repository: OfficialDataRefreshRuntimeRepository,
  options: OfficialDataRefreshJobOptions = {}
): OfficialDataRefreshJob {
  const provider = new MichiganLotteryGraphqlProvider();
  const refreshService = new OfficialLotteryDataService(repository, provider);
  const targetSource = new PostgresOfficialDataRefreshTargetSource(repository);
  return new OfficialDataRefreshJob(targetSource, refreshService, options);
}