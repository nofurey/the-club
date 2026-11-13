export type {
  ClubDiscoverySummary,
  ClubMemberView,
  ClubOverview,
  CreateContributionInput,
  CreateClubRequest,
  DrawingResultView,
  MembershipActionResult,
  MembershipRequestView,
  TicketDrawingOption,
  UpdateClubSettingsRequest,
  UpdateContributionResult,
  UserClubSummary,
} from "../../../src/api/contracts";

export type { Club, User } from "../../../src/domain";

import type { Contribution, User } from "../../../src/domain";
import type { ClubDiscoverySummary, ClubOverview, CreateClubRequest, CreateContributionInput, MembershipActionResult, MembershipRequestView, TicketDrawingOption, UpdateClubSettingsRequest, UpdateContributionResult, UserClubSummary } from "../../../src/api/contracts";
import type { Club } from "../../../src/domain";

export type ClubApiMode = "demo" | "oidc" | "unconfigured";

export interface ClubApi {
  readonly mode: ClubApiMode;
  initialize(): Promise<boolean>;
  signIn(): Promise<void>;
  signUp(): Promise<void>;
  signOut(): Promise<void>;
  closeAccount(): Promise<void>;
  getCurrentUser(): Promise<User>;
  getOverview(): Promise<ClubOverview>;
  getMyClubs(): Promise<UserClubSummary[]>;
  searchClubs(query: string): Promise<ClubDiscoverySummary[]>;
  requestMembership(clubId: string): Promise<MembershipActionResult>;
  getMembershipRequests(): Promise<MembershipRequestView[]>;
  approveMembership(userId: string): Promise<MembershipActionResult>;
  rejectMembership(userId: string): Promise<MembershipActionResult>;
  leaveClub(): Promise<MembershipActionResult>;
  removeMember(userId: string): Promise<MembershipActionResult>;
  updateMembershipRole(userId: string, role: "admin" | "member"): Promise<MembershipActionResult>;
  closeClub(): Promise<void>;
  transferOwnership(newOwnerUserId: string): Promise<void>;
  setActiveClubId(clubId: string): void;
  createClub(input: CreateClubRequest): Promise<ClubOverview>;
  updateClubSettings(input: UpdateClubSettingsRequest): Promise<Club>;
  getTicketDrawingOptions(): Promise<TicketDrawingOption[]>;
  createContribution(input: CreateContributionInput, photo?: File): Promise<Contribution>;
  updateContribution(contributionId: string, input: CreateContributionInput): Promise<UpdateContributionResult>;
  getContributionPhoto(contributionId: string): Promise<Blob>;
}