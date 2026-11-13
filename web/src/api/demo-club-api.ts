import type { ClubMembership, Contribution, Drawing, DrawingResult, NumberSet } from "../../../src/domain";
import type { CreateClubRequest } from "../../../src/api/contracts";
import { getDrawingCountOptions } from "../../../src/services/drawing-schedule";
import type { ClubApi, ClubMemberView, ClubOverview, CreateContributionInput, DrawingResultView } from "./contracts";

const now = "2026-11-09T12:00:00.000Z";
const clubId = "a1000000-0000-4000-8000-000000000001";
const ownerId = "a1000000-0000-4000-8000-000000000002";

const users = [
  { id: ownerId, displayName: "Alex Morgan", email: "alex@example.test", initials: "AM", role: "creator" as const },
  { id: "a1000000-0000-4000-8000-000000000003", displayName: "Jordan Lee", email: "jordan@example.test", initials: "JL", role: "admin" as const },
  { id: "a1000000-0000-4000-8000-000000000004", displayName: "Sam Rivera", email: "sam@example.test", initials: "SR", role: "member" as const },
  { id: "a1000000-0000-4000-8000-000000000005", displayName: "Priya Shah", email: "priya@example.test", initials: "PS", role: "member" as const },
  { id: "a1000000-0000-4000-8000-000000000006", displayName: "Taylor Brooks", email: "taylor@example.test", initials: "TB", role: "member" as const },
];

const membershipRows: ClubMemberView[] = users.map((user, index) => {
  const membership: ClubMembership = {
    id: `a1000000-0000-4000-8000-0000000001${index}`,
    clubId,
    userId: user.id,
    role: user.role,
    status: "active",
    joinedAt: `2026-09-${String(12 + index).padStart(2, "0")}T12:00:00.000Z`,
    approvedAt: `2026-09-${String(12 + index).padStart(2, "0")}T12:00:00.000Z`,
    removedAt: null,
    removedByUserId: null,
    createdAt: `2026-09-${String(12 + index).padStart(2, "0")}T12:00:00.000Z`,
    updatedAt: now,
  };
  return { ...membership, displayName: user.displayName, email: user.email, initials: user.initials, contributionTotalUsd: [68, 42, 34, 26, 18][index], ticketCount: [7, 5, 4, 3, 2][index] };
});

function makeContribution({
  id,
  userId,
  lottery,
  drawingDate,
  drawingCount,
  numbers,
  bonusNumber,
  costUsd,
}: {
  id: string;
  userId: string;
  lottery: "powerball" | "mega_millions";
  drawingDate: string;
  drawingCount: number;
  numbers: number[];
  bonusNumber: number;
  costUsd: number;
}): Contribution {
  const numberSet: NumberSet = {
    id: `${id}-set`,
    contributionId: id,
    numbers,
    bonusNumber: String(bonusNumber),
    createdAt: now,
  };
  return {
    id,
    clubId,
    userId,
    lottery,
    drawingDate,
    drawingCount,
    numberSets: [numberSet],
    ticketImageUrl: null,
    costUsd,
    status: "submitted",
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

const contributions: Contribution[] = [
  makeContribution({ id: "a2000000-0000-4000-8000-000000000001", userId: ownerId, lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 2, numbers: [7, 14, 21, 28, 35], bonusNumber: 9, costUsd: 4 }),
  makeContribution({ id: "a2000000-0000-4000-8000-000000000002", userId: users[1].id, lottery: "mega_millions", drawingDate: "2026-11-10", drawingCount: 1, numbers: [8, 19, 30, 41, 52], bonusNumber: 6, costUsd: 5 }),
  makeContribution({ id: "a2000000-0000-4000-8000-000000000003", userId: users[2].id, lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 1, numbers: [3, 16, 24, 47, 62], bonusNumber: 18, costUsd: 2 }),
  makeContribution({ id: "a2000000-0000-4000-8000-000000000004", userId: users[3].id, lottery: "mega_millions", drawingDate: "2026-11-10", drawingCount: 2, numbers: [11, 23, 36, 48, 65], bonusNumber: 3, costUsd: 10 }),
  makeContribution({ id: "a2000000-0000-4000-8000-000000000005", userId: users[4].id, lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 1, numbers: [5, 18, 33, 54, 68], bonusNumber: 11, costUsd: 2 }),
];

const drawings: Drawing[] = [
  { id: "a3000000-0000-4000-8000-000000000001", lottery: "powerball", drawingDate: "2026-11-09", state: "MI", cutoffTimeEt: "21:58:00", officialResultPostedAt: null, estimatedJackpot: 30000000, cashValue: 12900000, status: "pending", createdAt: now },
  { id: "a3000000-0000-4000-8000-000000000002", lottery: "mega_millions", drawingDate: "2026-11-10", state: "MI", cutoffTimeEt: "22:45:00", officialResultPostedAt: null, estimatedJackpot: 529000000, cashValue: 224200000, status: "pending", createdAt: now },
  { id: "a3000000-0000-4000-8000-000000000003", lottery: "powerball", drawingDate: "2026-11-07", state: "MI", cutoffTimeEt: "21:58:00", officialResultPostedAt: "2026-11-08T03:00:00.000Z", estimatedJackpot: 30000000, cashValue: 12900000, status: "calculated", createdAt: now },
  { id: "a3000000-0000-4000-8000-000000000004", lottery: "mega_millions", drawingDate: "2026-11-06", state: "MI", cutoffTimeEt: "22:45:00", officialResultPostedAt: "2026-11-07T04:00:00.000Z", estimatedJackpot: 505000000, cashValue: 213300000, status: "calculated", createdAt: now },
];

const results: DrawingResultView[] = drawings.map((drawing): DrawingResultView => {
  const isPending = drawing.status === "pending";
  const result: DrawingResult | null = isPending ? null : {
    id: `${drawing.id}-result`,
    drawingId: drawing.id,
    clubId,
    officialWinningNumbers: drawing.lottery === "powerball"
      ? { numbers: [3, 36, 37, 56, 61], bonusNumber: 21 }
      : { numbers: [27, 34, 44, 53, 64], bonusNumber: 1 },
    jackpotEstimate: drawing.estimatedJackpot ?? null,
    prizeBreakdown: {},
    status: drawing.status,
    calculationStartedAt: null,
    calculatedAt: drawing.officialResultPostedAt ?? null,
    sourceSnapshotId: null,
    createdAt: drawing.createdAt,
  };
  return {
    drawing,
    result,
    winningTicketCount: drawing.id.endsWith("003") ? 1 : 0,
    grossPrizeTotal: drawing.id.endsWith("003") ? 100 : 0,
  };
});

const club: ClubOverview["club"] = {
  id: clubId,
  name: "Lantern League",
  description: "A neighborhood pool for the big draws.",
  motto: "Better together, number by number.",
  visibility: "private",
  ownerUserId: ownerId,
  status: "active",
  payoutConfigurationId: "a4000000-0000-4000-8000-000000000001",
  thresholdRuleId: "a4000000-0000-4000-8000-000000000002",
  supportedLotteries: ["powerball", "mega_millions"],
  allowSearch: false,
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: now,
  closedAt: null,
};

let liveContributions = [...contributions];
const contributionPhotos = new Map<string, Blob>();

export const demoClubApi: ClubApi = {
  mode: "demo",
  async initialize() { return true; },
  async signIn() {},
  async getOverview() {
    const totalContributionsUsd = liveContributions.reduce((sum, contribution) => sum + contribution.costUsd, 0);
    const totalGrossPrizesUsd = results.reduce((sum, item) => sum + item.grossPrizeTotal, 0);
    return {
      club,
      currentUser: {
        id: ownerId,
        email: "alex@example.test",
        displayName: "Alex Morgan",
        isPhoneVerified: false,
        status: "active",
        createdAt: club.createdAt,
        updatedAt: now,
      },
      payoutConfiguration: { id: club.payoutConfigurationId!, clubId, type: "equal_shares", version: 1, createdAt: club.createdAt },
      thresholdRule: { id: club.thresholdRuleId!, clubId, thresholdAmount: 100, method: "pooled", createdAt: club.createdAt },
      members: membershipRows,
      contributions: liveContributions,
      results,
      totalContributionsUsd,
      totalGrossPrizesUsd,
    };
  },

  async getMyClubs() {
    return [{ id: club.id, name: club.name, visibility: club.visibility, role: "creator" as const }];
  },

  setActiveClubId() {},

  async updateClubSettings(input) {
    Object.assign(club, input);
    return club;
  },

  async createClub(_input: CreateClubRequest) {
    throw new Error("Club creation is available in authenticated mode.");
  },

  async getTicketDrawingOptions() {
    return drawings.filter((drawing) => drawing.status === "pending").map((drawing) => ({
      lottery: drawing.lottery,
      drawingDate: drawing.drawingDate,
      maxDrawingCount: 1,
      drawingCountOptions: getDrawingCountOptions(drawing.lottery, 1),
      maxNumberSets: 10,
      ticketPrice: drawing.lottery === "powerball" ? 2 : 5,
      numberRules: {
        mainNumberCount: 5,
        mainNumberMin: 1,
        mainNumberMax: drawing.lottery === "powerball" ? 69 : 70,
        bonusNumberMin: 1,
        bonusNumberMax: drawing.lottery === "powerball" ? 26 : 24,
      },
    }));
  },

  async createContribution(input: CreateContributionInput, photo?: File) {
    const id = crypto.randomUUID();
    const baseCost = input.lottery === "powerball" ? 2 : 5;
    const plays = input.numberSets ?? [{ numbers: input.numbers!, bonusNumber: input.bonusNumber! }];
    const contribution = makeContribution({
      id,
      userId: ownerId,
      lottery: input.lottery,
      drawingDate: input.drawingDate,
      drawingCount: input.drawingCount,
      numbers: plays[0].numbers,
      bonusNumber: plays[0].bonusNumber,
      costUsd: baseCost * input.drawingCount * plays.length,
    });
    contribution.numberSets = plays.map((play) => ({ id: crypto.randomUUID(), contributionId: id, numbers: play.numbers, bonusNumber: String(play.bonusNumber), createdAt: now }));
    if (photo) {
      contributionPhotos.set(id, photo);
      contribution.hasTicketPhoto = true;
    }
    liveContributions = [contribution, ...liveContributions];
    return contribution;
  },

  async updateContribution(contributionId: string, input: CreateContributionInput) {
    const existing = liveContributions.find((item) => item.id === contributionId && item.userId === ownerId);
    if (!existing) throw new Error("Ticket was not found or is no longer editable.");
    const plays = input.numberSets ?? [{ numbers: input.numbers!, bonusNumber: input.bonusNumber! }];
    const updated: Contribution = {
      ...existing,
      lottery: input.lottery,
      drawingDate: input.drawingDate,
      drawingCount: input.drawingCount,
      numberSets: plays.map((play) => ({ id: crypto.randomUUID(), contributionId, numbers: play.numbers, bonusNumber: String(play.bonusNumber), createdAt: now })),
      costUsd: (input.lottery === "powerball" ? 2 : 5) * input.drawingCount * plays.length,
      updatedAt: new Date().toISOString(),
      version: existing.version + 1,
    };
    liveContributions = liveContributions.map((item) => item.id === contributionId ? updated : item);
    return updated;
  },

  async getContributionPhoto(contributionId: string) {
    const photo = contributionPhotos.get(contributionId);
    if (!photo) throw new Error("Ticket photo not found.");
    return photo;
  },
};