import type {
  ClubMembership,
  Contribution,
  PayoutConfiguration,
  ThresholdRule,
} from "../domain";

export interface DrawingPrizeValue {
  userId: string;
  amount: number;
}

export interface PayoutAllocation {
  userId: string;
  amount: number;
  thresholdMet: boolean;
  reason: "winning-ticket" | "equal-share" | "proportion";
}

export interface GetEligibleMembersInput {
  memberships: ClubMembership[];
  drawingDate: string;
  cutoffAt: string;
}

export interface CalculatePayoutInput {
  eligibleMemberIds: string[];
  contributions: Contribution[];
  drawingContributionIds?: string[];
  prizeValues: DrawingPrizeValue[];
  thresholdRule: Pick<ThresholdRule, "thresholdAmount" | "method">;
  payoutConfiguration: Pick<PayoutConfiguration, "type">;
}

export class PayoutService {
  getEligibleMembersForDrawing({ memberships, drawingDate, cutoffAt }: GetEligibleMembersInput): string[] {
    const cutoffTime = new Date(cutoffAt).getTime();
    if (!Number.isFinite(cutoffTime) || !/^\d{4}-\d{2}-\d{2}$/.test(drawingDate)) {
      throw new Error("A valid drawing date and cutoff timestamp are required.");
    }

    return memberships
      .filter((membership) => this.isEligibleForDrawing({ membership, cutoffAt }))
      .map((membership) => membership.userId)
      .filter((userId, index, ids) => ids.indexOf(userId) === index)
      .sort();
  }

  isEligibleForDrawing({ membership, cutoffAt }: { membership: ClubMembership; cutoffAt: string }): boolean {
    const cutoffTime = new Date(cutoffAt).getTime();
    if (!Number.isFinite(cutoffTime)) {
      return false;
    }

    if (membership.status !== "active" && membership.status !== "removed") {
      return false;
    }

    const approvedAt = new Date(membership.approvedAt ?? membership.joinedAt).getTime();
    if (!Number.isFinite(approvedAt) || approvedAt > cutoffTime) {
      return false;
    }

    if (membership.status === "removed") {
      const removedAt = membership.removedAt ? new Date(membership.removedAt).getTime() : Number.NaN;
      return Number.isFinite(removedAt) && removedAt > cutoffTime;
    }

    return !membership.removedAt || new Date(membership.removedAt).getTime() > cutoffTime;
  }

  calculatePayout({
    eligibleMemberIds,
    contributions,
    drawingContributionIds = [],
    prizeValues,
    thresholdRule,
    payoutConfiguration,
  }: CalculatePayoutInput): { allocations: PayoutAllocation[]; totalPrize: number; thresholdMet: boolean } {
    const eligibleIds = [...new Set(eligibleMemberIds)].sort();
    const eligibleSet = new Set(eligibleIds);
    const validPrizes = prizeValues.filter(
      (prize) => eligibleSet.has(prize.userId) && Number.isFinite(prize.amount) && prize.amount >= 0
    );
    const totalPrize = this.roundCurrency(validPrizes.reduce((sum, prize) => sum + prize.amount, 0));
    const allocations = new Map(eligibleIds.map((userId) => [userId, 0]));
    const pooledPrizes = thresholdRule.method === "pooled"
      ? totalPrize >= thresholdRule.thresholdAmount ? validPrizes : []
      : validPrizes.filter((prize) => prize.amount >= thresholdRule.thresholdAmount);
    const directPrizes = thresholdRule.method === "pooled" && pooledPrizes.length === 0
      ? validPrizes
      : thresholdRule.method === "individual"
        ? validPrizes.filter((prize) => prize.amount < thresholdRule.thresholdAmount)
        : [];

    for (const prize of directPrizes) {
      allocations.set(prize.userId, (allocations.get(prize.userId) ?? 0) + prize.amount);
    }

    const pooledTotal = pooledPrizes.reduce((sum, prize) => sum + prize.amount, 0);
    if (pooledTotal > 0 && eligibleIds.length > 0) {
      if (payoutConfiguration.type === "equal_shares") {
        this.addEqualShares(allocations, eligibleIds, pooledTotal);
      } else {
        const applicableContributionIds = payoutConfiguration.type === "proportion_drawing_specific"
          ? new Set(drawingContributionIds)
          : null;
        const weights = this.getContributionWeights({
          eligibleIds,
          contributions,
          applicableContributionIds,
          divideByDrawingCount: payoutConfiguration.type === "proportion_drawing_specific",
        });
        this.addProportionalShares(allocations, eligibleIds, pooledTotal, weights);
      }
    }

    const thresholdMet = pooledPrizes.length > 0;
    return {
      allocations: eligibleIds.map((userId) => ({
        userId,
        amount: this.roundCurrency(allocations.get(userId) ?? 0),
        thresholdMet,
        reason: thresholdMet
          ? payoutConfiguration.type === "equal_shares" ? "equal-share" : "proportion"
          : "winning-ticket",
      })),
      totalPrize,
      thresholdMet,
    };
  }

  private addEqualShares(allocations: Map<string, number>, eligibleIds: string[], amount: number): void {
    const cents = Math.round(amount * 100);
    const baseCents = Math.floor(cents / eligibleIds.length);
    const remainder = cents - baseCents * eligibleIds.length;

    eligibleIds.forEach((userId, index) => {
      allocations.set(userId, (allocations.get(userId) ?? 0) + (baseCents + (index < remainder ? 1 : 0)) / 100);
    });
  }

  private addProportionalShares(
    allocations: Map<string, number>,
    eligibleIds: string[],
    amount: number,
    weights: Map<string, number>
  ): void {
    const totalWeight = eligibleIds.reduce((sum, userId) => sum + (weights.get(userId) ?? 0), 0);
    if (totalWeight <= 0) {
      return;
    }

    const recipients = eligibleIds.filter((userId) => (weights.get(userId) ?? 0) > 0);
    const totalCents = Math.round(amount * 100);
    let remainingCents = totalCents;

    recipients.forEach((userId, index) => {
      const cents = index === recipients.length - 1
        ? remainingCents
        : Math.floor(totalCents * (weights.get(userId) ?? 0) / totalWeight);
      allocations.set(userId, (allocations.get(userId) ?? 0) + cents / 100);
      remainingCents -= cents;
    });
  }

  private getContributionWeights({
    eligibleIds,
    contributions,
    applicableContributionIds,
    divideByDrawingCount,
  }: {
    eligibleIds: string[];
    contributions: Contribution[];
    applicableContributionIds: Set<string> | null;
    divideByDrawingCount: boolean;
  }): Map<string, number> {
    const eligibleSet = new Set(eligibleIds);
    const weights = new Map(eligibleIds.map((userId) => [userId, 0]));

    for (const contribution of contributions) {
      if (!eligibleSet.has(contribution.userId) || contribution.status === "draft" || contribution.status === "archived") {
        continue;
      }
      if (applicableContributionIds && !applicableContributionIds.has(contribution.id)) {
        continue;
      }

      const drawingCount = divideByDrawingCount ? Math.max(1, contribution.drawingCount) : 1;
      const weight = Number(contribution.costUsd) / drawingCount;
      weights.set(contribution.userId, (weights.get(contribution.userId) ?? 0) + weight);
    }

    return weights;
  }

  private roundCurrency(amount: number): number {
    return Math.round((amount + Number.EPSILON) * 100) / 100;
  }
}
