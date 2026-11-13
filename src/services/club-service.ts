import type {
  Club,
  ClubMembership,
  ClubStatus,
  ClubVisibility,
  Contribution,
  LotteryType,
  MembershipRole,
  MembershipStatus,
  PayoutConfiguration,
  PayoutType,
  ThresholdMethod,
  ThresholdRule,
} from "../domain";

export interface CreateClubInput {
  name: string;
  description?: string | null;
  motto?: string | null;
  visibility: ClubVisibility;
  ownerUserId: string;
  supportedLotteries: LotteryType[];
  payoutConfiguration: Pick<PayoutConfiguration, "type">;
  thresholdRule: Pick<ThresholdRule, "thresholdAmount" | "method">;
  allowSearch?: boolean;
}

export interface RequestMembershipInput {
  clubId: string;
  userId: string;
}

export interface UpdateMembershipInput {
  clubId: string;
  userId: string;
  actingUserId: string;
}

export interface TransferOwnershipInput {
  clubId: string;
  currentOwnerUserId: string;
  newOwnerUserId: string;
}

export interface CloseClubInput {
  clubId: string;
  actingUserId: string;
}

export interface ClubRepository {
  createClub(club: Club): Promise<Club>;
  updateClub(club: Club): Promise<Club>;
  findClubById(clubId: string): Promise<Club | null>;

  createMembership(membership: ClubMembership): Promise<ClubMembership>;
  updateMembership(membership: ClubMembership): Promise<ClubMembership>;
  findMembershipByClubAndUser(clubId: string, userId: string): Promise<ClubMembership | null>;
  findMembershipsByClub(clubId: string): Promise<ClubMembership[]>;

  createPayoutConfiguration(config: PayoutConfiguration): Promise<PayoutConfiguration>;
  createThresholdRule(rule: ThresholdRule): Promise<ThresholdRule>;

  hasFutureContributionForUserInClub(userId: string, clubId: string): Promise<boolean>;
  hasPendingPayoutForUserInClub(userId: string, clubId: string): Promise<boolean>;
  hasCutoffCalculationInProgress(clubId: string): Promise<boolean>;
  hasIncompletePayouts(clubId: string): Promise<boolean>;
  findContributionsForClub(clubId: string): Promise<Contribution[]>;
}

export class ClubService {
  constructor(private readonly repo: ClubRepository) {}

  async createClub(input: CreateClubInput): Promise<{
    club: Club;
    membership: ClubMembership;
    payoutConfiguration: PayoutConfiguration;
    thresholdRule: ThresholdRule;
  }> {
    this.validateCreateClubInput(input);

    const now = new Date().toISOString();
    const clubId = this.generateId();

    const club: Club = {
      id: clubId,
      name: input.name.trim(),
      description: input.description ?? null,
      motto: input.motto ?? null,
      visibility: input.visibility,
      ownerUserId: input.ownerUserId,
      status: "active",
      payoutConfigurationId: undefined,
      thresholdRuleId: undefined,
      supportedLotteries: input.supportedLotteries,
      allowSearch: input.allowSearch ?? true,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };

    const createdClub = await this.repo.createClub(club);

    const payoutConfiguration: PayoutConfiguration = {
      id: this.generateId(),
      clubId: createdClub.id,
      type: input.payoutConfiguration.type,
      version: 1,
      createdAt: now,
    };

    const thresholdRule: ThresholdRule = {
      id: this.generateId(),
      clubId: createdClub.id,
      thresholdAmount: input.thresholdRule.thresholdAmount,
      method: input.thresholdRule.method,
      createdAt: now,
    };

    const createdPayoutConfiguration = await this.repo.createPayoutConfiguration(payoutConfiguration);
    const createdThresholdRule = await this.repo.createThresholdRule(thresholdRule);

    const creatorMembership: ClubMembership = {
      id: this.generateId(),
      clubId: createdClub.id,
      userId: input.ownerUserId,
      role: "creator",
      status: "active",
      joinedAt: now,
      approvedAt: now,
      removedAt: null,
      removedByUserId: null,
      createdAt: now,
      updatedAt: now,
    };

    const createdMembership = await this.repo.createMembership(creatorMembership);

    const finalClub: Club = {
      ...createdClub,
      payoutConfigurationId: createdPayoutConfiguration.id,
      thresholdRuleId: createdThresholdRule.id,
    };

    await this.repo.updateClub(finalClub);

    return {
      club: finalClub,
      membership: createdMembership,
      payoutConfiguration: createdPayoutConfiguration,
      thresholdRule: createdThresholdRule,
    };
  }

  async requestMembership({ clubId, userId }: RequestMembershipInput): Promise<ClubMembership> {
    const club = await this.repo.findClubById(clubId);
    if (!club) {
      throw new Error("Club not found.");
    }

    const existing = await this.repo.findMembershipByClubAndUser(clubId, userId);
    if (existing) {
      if (existing.status !== "removed") return existing;
      const now = new Date().toISOString();
      const reactivated: ClubMembership = {
        ...existing,
        role: "member",
        status: club.visibility === "public" ? "active" : "pending",
        joinedAt: now,
        approvedAt: club.visibility === "public" ? now : null,
        removedAt: null,
        removedByUserId: null,
        updatedAt: now,
      };
      return this.repo.updateMembership(reactivated);
    }

    const now = new Date().toISOString();
    const isPublic = club.visibility === "public";

    const membership: ClubMembership = {
      id: this.generateId(),
      clubId,
      userId,
      role: "member",
      status: isPublic ? "active" : "pending",
      joinedAt: now,
      approvedAt: isPublic ? now : null,
      removedAt: null,
      removedByUserId: null,
      createdAt: now,
      updatedAt: now,
    };

    return this.repo.createMembership(membership);
  }

  async approveMembership({ clubId, userId, actingUserId }: UpdateMembershipInput): Promise<ClubMembership> {
    await this.assertModeratorPermission(clubId, actingUserId);

    const membership = await this.repo.findMembershipByClubAndUser(clubId, userId);
    if (!membership) {
      throw new Error("Membership not found.");
    }

    if (membership.status !== "pending") {
      throw new Error("Membership is not pending approval.");
    }

    const updated: ClubMembership = {
      ...membership,
      status: "active",
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return this.repo.updateMembership(updated);
  }

  async rejectMembership({ clubId, userId, actingUserId }: UpdateMembershipInput): Promise<ClubMembership> {
    await this.assertModeratorPermission(clubId, actingUserId);

    const membership = await this.repo.findMembershipByClubAndUser(clubId, userId);
    if (!membership) {
      throw new Error("Membership not found.");
    }
    if (membership.status !== "pending") {
      throw new Error("Membership is not pending approval.");
    }

    const updated: ClubMembership = {
      ...membership,
      status: "removed",
      removedAt: new Date().toISOString(),
      removedByUserId: actingUserId,
      updatedAt: new Date().toISOString(),
    };

    return this.repo.updateMembership(updated);
  }

  async leaveClub(clubId: string, userId: string): Promise<ClubMembership> {
    const membership = await this.repo.findMembershipByClubAndUser(clubId, userId);
    if (!membership) {
      throw new Error("Membership not found.");
    }

    if (membership.role === "creator") {
      throw new Error("Creator must transfer ownership before leaving the club.");
    }

    if (membership.status !== "active") {
      throw new Error("Only active members can leave a club.");
    }

    const hasFutureContribution = await this.repo.hasFutureContributionForUserInClub(userId, clubId);
    if (hasFutureContribution) {
      throw new Error("User cannot leave while they have active contributions for future drawings.");
    }

    const updated: ClubMembership = {
      ...membership,
      status: "removed",
      removedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return this.repo.updateMembership(updated);
  }

  async removeMember({ clubId, userId, actingUserId }: UpdateMembershipInput): Promise<ClubMembership> {
    const actingMembership = await this.repo.findMembershipByClubAndUser(clubId, actingUserId);
    if (!actingMembership || actingMembership.status !== "active" || actingMembership.role !== "creator") {
      throw new Error("Only the creator may forcibly remove a member.");
    }

    const membership = await this.repo.findMembershipByClubAndUser(clubId, userId);
    if (!membership) {
      throw new Error("Target membership not found.");
    }

    if (membership.role === "creator") {
      throw new Error("Creator cannot be removed through this workflow.");
    }
    if (membership.status !== "active") {
      throw new Error("Only active members can be forcibly removed.");
    }
    if (await this.repo.hasCutoffCalculationInProgress(clubId)) {
      throw new Error("Member removal is blocked until post-cutoff payout calculations are complete.");
    }
    if (await this.repo.hasPendingPayoutForUserInClub(userId, clubId)) {
      throw new Error("Member removal is blocked while the member has a pending payout.");
    }

    const updated: ClubMembership = {
      ...membership,
      status: "removed",
      removedAt: new Date().toISOString(),
      removedByUserId: actingUserId,
      updatedAt: new Date().toISOString(),
    };

    return this.repo.updateMembership(updated);
  }

  async updateMembershipRole(clubId: string, userId: string, actingUserId: string, role: "admin" | "member"): Promise<ClubMembership> {
    const actingMembership = await this.repo.findMembershipByClubAndUser(clubId, actingUserId);
    if (!actingMembership || actingMembership.status !== "active" || actingMembership.role !== "creator") {
      throw new Error("Only the creator may change member roles.");
    }
    const membership = await this.repo.findMembershipByClubAndUser(clubId, userId);
    if (!membership || membership.status !== "active") {
      throw new Error("An active target membership is required.");
    }
    if (membership.role === "creator") {
      throw new Error("Creator role can only change through ownership transfer.");
    }
    return this.repo.updateMembership({ ...membership, role, updatedAt: new Date().toISOString() });
  }

  async transferOwnership({ clubId, currentOwnerUserId, newOwnerUserId }: TransferOwnershipInput): Promise<Club> {
    const club = await this.repo.findClubById(clubId);
    if (!club) {
      throw new Error("Club not found.");
    }

    if (club.ownerUserId !== currentOwnerUserId) {
      throw new Error("Only the current owner may transfer ownership.");
    }

    const targetMembership = await this.repo.findMembershipByClubAndUser(clubId, newOwnerUserId);
    if (!targetMembership || targetMembership.status !== "active") {
      throw new Error("Target user must be an active club member.");
    }

    if (targetMembership.role !== "admin") {
      throw new Error("Ownership can only be transferred to an Admin.");
    }

    const memberships = await this.repo.findMembershipsByClub(clubId);
    const currentOwnerMembership = memberships.find((m) => m.userId === currentOwnerUserId);
    if (!currentOwnerMembership) {
      throw new Error("Current owner membership not found.");
    }

    const updatedClub: Club = {
      ...club,
      ownerUserId: newOwnerUserId,
      updatedAt: new Date().toISOString(),
    };

    await this.repo.updateClub(updatedClub);

    const previousCreatorUpdated: ClubMembership = {
      ...currentOwnerMembership,
      role: "admin",
      updatedAt: new Date().toISOString(),
    };

    await this.repo.updateMembership(previousCreatorUpdated);

    const newOwnerUpdated: ClubMembership = {
      ...targetMembership,
      role: "creator",
      updatedAt: new Date().toISOString(),
    };

    await this.repo.updateMembership(newOwnerUpdated);

    return updatedClub;
  }

  async closeClub({ clubId, actingUserId }: CloseClubInput): Promise<Club> {
    const club = await this.repo.findClubById(clubId);
    if (!club) {
      throw new Error("Club not found.");
    }

    if (club.ownerUserId !== actingUserId) {
      throw new Error("Only the creator may close the club.");
    }

    const hasFutureContribution = await this.repo.findContributionsForClub(clubId).then((items) =>
      items.some((contribution) => new Date(contribution.drawingDate) > new Date())
    );

    if (hasFutureContribution) {
      throw new Error("Closure is blocked while there are contributions for future drawings.");
    }

    const hasIncompletePayouts = await this.repo.hasIncompletePayouts(clubId);
    if (hasIncompletePayouts) {
      throw new Error("Closure is blocked while any drawing payout is incomplete.");
    }

    const updatedClub: Club = {
      ...club,
      status: "closed",
      updatedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
    };

    return this.repo.updateClub(updatedClub);
  }

  private async assertModeratorPermission(clubId: string, actingUserId: string): Promise<void> {
    const membership = await this.repo.findMembershipByClubAndUser(clubId, actingUserId);
    if (!membership || membership.status !== "active") {
      throw new Error("User is not a member of the club.");
    }

    if (!this.isCreatorOrAdmin(membership.role)) {
      throw new Error("Only creator or admin may approve or reject membership requests.");
    }
  }

  private isCreatorOrAdmin(role: MembershipRole): boolean {
    return role === "creator" || role === "admin";
  }

  private validateCreateClubInput(input: CreateClubInput): void {
    if (!input.name || !input.name.trim()) {
      throw new Error("Club name is required.");
    }

    if (!input.ownerUserId) {
      throw new Error("Club owner is required.");
    }

    if (!input.supportedLotteries || input.supportedLotteries.length === 0) {
      throw new Error("At least one supported lottery is required.");
    }

    if (!input.payoutConfiguration || !input.payoutConfiguration.type) {
      throw new Error("Payout configuration is required.");
    }

    if (!input.thresholdRule || input.thresholdRule.thresholdAmount <= 0) {
      throw new Error("Threshold amount must be greater than zero.");
    }

    const validThresholdMethods: ThresholdMethod[] = ["pooled", "individual"];
    if (!validThresholdMethods.includes(input.thresholdRule.method)) {
      throw new Error("Threshold method must be pooled or individual.");
    }

    const validPayoutTypes: PayoutType[] = [
      "equal_shares",
      "proportion_drawing_specific",
      "proportion_all_drawings",
    ];

    if (!validPayoutTypes.includes(input.payoutConfiguration.type)) {
      throw new Error("Invalid payout configuration type.");
    }
  }

  private generateId(): string {
    const maybeCrypto = (globalThis as any).crypto;
    if (maybeCrypto && typeof maybeCrypto.randomUUID === "function") {
      return maybeCrypto.randomUUID();
    }

    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export interface ClubServiceApi {
  createClub(input: CreateClubInput): Promise<{
    club: Club;
    membership: ClubMembership;
    payoutConfiguration: PayoutConfiguration;
    thresholdRule: ThresholdRule;
  }>;
  requestMembership(input: RequestMembershipInput): Promise<ClubMembership>;
  approveMembership(input: UpdateMembershipInput): Promise<ClubMembership>;
  rejectMembership(input: UpdateMembershipInput): Promise<ClubMembership>;
  leaveClub(clubId: string, userId: string): Promise<ClubMembership>;
  removeMember(input: UpdateMembershipInput): Promise<ClubMembership>;
  transferOwnership(input: TransferOwnershipInput): Promise<Club>;
  closeClub(input: CloseClubInput): Promise<Club>;
}
