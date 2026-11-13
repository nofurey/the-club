export type {
  ClubMemberView,
  ClubOverview,
  CreateContributionInput,
  CreateClubRequest,
  DrawingResultView,
  TicketDrawingOption,
  UpdateClubSettingsRequest,
  UserClubSummary,
} from "../../../src/api/contracts";

export type { Club } from "../../../src/domain";

import type { Contribution } from "../../../src/domain";
import type { ClubOverview, CreateClubRequest, CreateContributionInput, TicketDrawingOption, UpdateClubSettingsRequest, UserClubSummary } from "../../../src/api/contracts";
import type { Club } from "../../../src/domain";

export type ClubApiMode = "demo" | "oidc" | "unconfigured";

export interface ClubApi {
  readonly mode: ClubApiMode;
  initialize(): Promise<boolean>;
  signIn(): Promise<void>;
  getOverview(): Promise<ClubOverview>;
  getMyClubs(): Promise<UserClubSummary[]>;
  setActiveClubId(clubId: string): void;
  createClub(input: CreateClubRequest): Promise<ClubOverview>;
  updateClubSettings(input: UpdateClubSettingsRequest): Promise<Club>;
  getTicketDrawingOptions(): Promise<TicketDrawingOption[]>;
  createContribution(input: CreateContributionInput, photo?: File): Promise<Contribution>;
  updateContribution(contributionId: string, input: CreateContributionInput): Promise<Contribution>;
  getContributionPhoto(contributionId: string): Promise<Blob>;
}