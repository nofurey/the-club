export type {
  ClubMemberView,
  ClubOverview,
  CreateContributionInput,
  DrawingResultView,
  TicketDrawingOption,
} from "../../../src/api/contracts";

import type { Contribution } from "../../../src/domain";
import type { ClubOverview, CreateContributionInput, TicketDrawingOption } from "../../../src/api/contracts";

export type ClubApiMode = "demo" | "oidc" | "unconfigured";

export interface ClubApi {
  readonly mode: ClubApiMode;
  initialize(): Promise<boolean>;
  signIn(): Promise<void>;
  getOverview(): Promise<ClubOverview>;
  getTicketDrawingOptions(): Promise<TicketDrawingOption[]>;
  createContribution(input: CreateContributionInput, photo?: File): Promise<Contribution>;
  getContributionPhoto(contributionId: string): Promise<Blob>;
}