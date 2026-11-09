import type {
  Club,
  ClubMembership,
  Contribution,
  PayoutConfiguration,
  ThresholdRule,
} from "../domain";
import type { ClubRepository } from "./club-service";

export class InMemoryClubRepository implements ClubRepository {
  private readonly clubs = new Map<string, Club>();
  private readonly memberships = new Map<string, ClubMembership>();
  private readonly payoutConfigurations = new Map<string, PayoutConfiguration>();
  private readonly thresholdRules = new Map<string, ThresholdRule>();
  private readonly contributions = new Map<string, Contribution>();

  async createClub(club: Club): Promise<Club> {
    this.clubs.set(club.id, { ...club });
    return { ...club };
  }

  async updateClub(club: Club): Promise<Club> {
    this.clubs.set(club.id, { ...club });
    return { ...club };
  }

  async findClubById(clubId: string): Promise<Club | null> {
    const club = this.clubs.get(clubId);
    return club ? { ...club } : null;
  }

  async createMembership(membership: ClubMembership): Promise<ClubMembership> {
    this.memberships.set(`${membership.clubId}:${membership.userId}`, { ...membership });
    return { ...membership };
  }

  async updateMembership(membership: ClubMembership): Promise<ClubMembership> {
    this.memberships.set(`${membership.clubId}:${membership.userId}`, { ...membership });
    return { ...membership };
  }

  async findMembershipByClubAndUser(clubId: string, userId: string): Promise<ClubMembership | null> {
    const membership = this.memberships.get(`${clubId}:${userId}`);
    return membership ? { ...membership } : null;
  }

  async findMembershipsByClub(clubId: string): Promise<ClubMembership[]> {
    return Array.from(this.memberships.values())
      .filter((membership) => membership.clubId === clubId)
      .map((membership) => ({ ...membership }));
  }

  async createPayoutConfiguration(config: PayoutConfiguration): Promise<PayoutConfiguration> {
    this.payoutConfigurations.set(config.clubId, { ...config });
    return { ...config };
  }

  async createThresholdRule(rule: ThresholdRule): Promise<ThresholdRule> {
    this.thresholdRules.set(rule.clubId, { ...rule });
    return { ...rule };
  }

  async hasFutureContributionForUserInClub(userId: string, clubId: string): Promise<boolean> {
    const today = new Date();

    for (const contribution of this.contributions.values()) {
      if (contribution.userId === userId && contribution.clubId === clubId) {
        const drawingDate = new Date(contribution.drawingDate);
        if (drawingDate > today) {
          return true;
        }
      }
    }

    return false;
  }

  async hasIncompletePayouts(clubId: string): Promise<boolean> {
    return false;
  }

  async findContributionsForClub(clubId: string): Promise<Contribution[]> {
    return Array.from(this.contributions.values())
      .filter((contribution) => contribution.clubId === clubId)
      .map((contribution) => ({ ...contribution }));
  }

  addContribution(contribution: Contribution): void {
    this.contributions.set(contribution.id, { ...contribution });
  }
}
