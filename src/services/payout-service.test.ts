import assert from "node:assert/strict";
import test from "node:test";

import type { ClubMembership, Contribution } from "../domain";
import { PayoutService } from "./payout-service";

const memberships: ClubMembership[] = [
  {
    id: "m1",
    clubId: "club-1",
    userId: "u1",
    role: "member",
    status: "active",
    joinedAt: "2025-01-01T00:00:00.000Z",
    approvedAt: "2025-01-01T00:00:00.000Z",
    removedAt: null,
    removedByUserId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "m2",
    clubId: "club-1",
    userId: "u2",
    role: "member",
    status: "active",
    joinedAt: "2025-01-02T00:00:00.000Z",
    approvedAt: "2025-01-02T00:00:00.000Z",
    removedAt: null,
    removedByUserId: null,
    createdAt: "2025-01-02T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: "m3",
    clubId: "club-1",
    userId: "u3",
    role: "member",
    status: "pending",
    joinedAt: "2025-01-03T00:00:00.000Z",
    approvedAt: null,
    removedAt: null,
    removedByUserId: null,
    createdAt: "2025-01-03T00:00:00.000Z",
    updatedAt: "2025-01-03T00:00:00.000Z",
  },
];

const contributions: Contribution[] = [
  {
    id: "c1",
    clubId: "club-1",
    userId: "u1",
    lottery: "powerball",
    drawingDate: "2025-01-05",
    drawingCount: 1,
    numberSets: [{ numbers: [1, 2, 3, 4, 5], bonusNumber: "6" }],
    ticketImageUrl: null,
    costUsd: 10,
    status: "submitted",
    createdAt: "2025-01-03T00:00:00.000Z",
    updatedAt: "2025-01-03T00:00:00.000Z",
    version: 1,
  },
  {
    id: "c2",
    clubId: "club-1",
    userId: "u2",
    lottery: "powerball",
    drawingDate: "2025-01-05",
    drawingCount: 1,
    numberSets: [{ numbers: [7, 8, 9, 10, 11], bonusNumber: "12" }],
    ticketImageUrl: null,
    costUsd: 20,
    status: "submitted",
    createdAt: "2025-01-03T00:00:00.000Z",
    updatedAt: "2025-01-03T00:00:00.000Z",
    version: 1,
  },
];

test("eligible members are limited to active members who joined before the cutoff", () => {
  const service = new PayoutService();

  const eligible = service.getEligibleMembersForDrawing({
    memberships: [
      ...memberships,
      {
        ...memberships[0],
        id: "m4",
        userId: "u4",
        status: "removed",
        removedAt: "2025-01-06T04:00:00.000Z",
      },
      {
        ...memberships[0],
        id: "m5",
        userId: "u5",
        status: "removed",
        removedAt: "2025-01-04T00:00:00.000Z",
      },
    ],
    drawingDate: "2025-01-05",
    cutoffAt: "2025-01-05T21:58:00-05:00",
  });

  assert.deepEqual(eligible, ["u1", "u2", "u4"]);
});

test("pooled threshold with equal shares divvies the full drawing among eligible members", () => {
  const service = new PayoutService();

  const result = service.calculatePayout({
    eligibleMemberIds: ["u1", "u2"],
    contributions,
    prizeValues: [
      { userId: "u1", amount: 60 },
      { userId: "u2", amount: 90 },
    ],
    thresholdRule: { thresholdAmount: 100, method: "pooled" },
    payoutConfiguration: { type: "equal_shares" },
  });

  assert.deepEqual(
    result.allocations.map((allocation) => ({
      userId: allocation.userId,
      amount: Number(allocation.amount.toFixed(2)),
    })),
    [
      { userId: "u1", amount: 75 },
      { userId: "u2", amount: 75 },
    ]
  );
});

test("proportion all drawings allocates winnings by total eligible spend", () => {
  const service = new PayoutService();

  const result = service.calculatePayout({
    eligibleMemberIds: ["u1", "u2"],
    contributions,
    prizeValues: [
      { userId: "u1", amount: 100 },
      { userId: "u2", amount: 0 },
    ],
    thresholdRule: { thresholdAmount: 50, method: "pooled" },
    payoutConfiguration: { type: "proportion_all_drawings" },
  });

  assert.deepEqual(
    result.allocations.map((allocation) => ({
      userId: allocation.userId,
      amount: Number(allocation.amount.toFixed(2)),
    })),
    [
      { userId: "u1", amount: 33.33 },
      { userId: "u2", amount: 66.67 },
    ]
  );
});

test("individual thresholds pool qualifying prizes but pay smaller prizes to their winners", () => {
  const service = new PayoutService();

  const result = service.calculatePayout({
    eligibleMemberIds: ["u1", "u2"],
    contributions,
    prizeValues: [
      { userId: "u1", amount: 120 },
      { userId: "u2", amount: 30 },
    ],
    thresholdRule: { thresholdAmount: 100, method: "individual" },
    payoutConfiguration: { type: "equal_shares" },
  });

  assert.deepEqual(
    result.allocations.map(({ userId, amount }) => ({ userId, amount })),
    [
      { userId: "u1", amount: 60 },
      { userId: "u2", amount: 90 },
    ]
  );
});

test("drawing-specific proportion divides multi-drawing ticket costs across drawings", () => {
  const service = new PayoutService();
  const drawingContributions = contributions.map((contribution) =>
    contribution.id === "c1" ? { ...contribution, drawingCount: 2 } : contribution
  );

  const result = service.calculatePayout({
    eligibleMemberIds: ["u1", "u2"],
    contributions: drawingContributions,
    drawingContributionIds: ["c1", "c2"],
    prizeValues: [{ userId: "u1", amount: 100 }],
    thresholdRule: { thresholdAmount: 100, method: "pooled" },
    payoutConfiguration: { type: "proportion_drawing_specific" },
  });

  assert.deepEqual(
    result.allocations.map(({ userId, amount }) => ({ userId, amount })),
    [
      { userId: "u1", amount: 20 },
      { userId: "u2", amount: 80 },
    ]
  );
});
