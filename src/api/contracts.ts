import type {
  Club,
  ClubMembership,
  Contribution,
  Drawing,
  DrawingResult,
  LotteryType,
  MembershipRole,
  MembershipStatus,
  Notification,
  NotificationPreference,
  PayoutType,
  PrizeAwardStatus,
  PayoutConfiguration,
  ThresholdRule,
  User,
} from "../domain";

export interface ClubMemberView extends ClubMembership {
  displayName: string;
  email: string;
  initials: string;
  contributionTotalUsd: number;
  ticketCount: number;
}

export interface DrawingResultView {
  drawing: Drawing;
  result: DrawingResult | null;
  winningTicketCount: number;
  grossPrizeTotal: number;
  payouts: DrawingPayoutView[];
}

export interface DrawingPayoutView {
  userId: string;
  memberName: string;
  prizeType: string;
  grossPrizeAmount: number;
  shareAmount: number;
  thresholdMet: boolean;
  payoutType: PayoutType | null;
  status: PrizeAwardStatus;
}

export interface ClubOverview {
  club: Club;
  currentUser: User;
  payoutConfiguration: PayoutConfiguration;
  thresholdRule: ThresholdRule;
  members: ClubMemberView[];
  contributions: Contribution[];
  results: DrawingResultView[];
  totalContributionsUsd: number;
  totalGrossPrizesUsd: number;
}

export interface TicketNumberSetInput {
  numbers: number[];
  bonusNumber: number;
  powerPlay?: boolean;
  doublePlay?: boolean;
  megaplier?: number;
}

export type CreateContributionInput = {
  lottery: LotteryType;
  drawingDate: string;
  drawingCount: number;
} & (TicketNumberSetInput & { numberSets?: never } | { numberSets: TicketNumberSetInput[]; numbers?: never; bonusNumber?: never });

export interface TicketDrawingOption {
  lottery: LotteryType;
  drawingDate: string;
  existingTicketDate?: boolean;
  maxDrawingCount: number;
  drawingCountOptions: number[];
  maxNumberSets: number;
  ticketPrice: number | null;
  numberRules: {
    mainNumberCount: number;
    mainNumberMin: number;
    mainNumberMax: number;
    bonusNumberMin: number;
    bonusNumberMax: number;
  } | null;
}

export interface CreateClubRequest {
  name: string;
  description?: string | null;
  motto?: string | null;
  visibility: "public" | "private";
  supportedLotteries: LotteryType[];
  allowSearch?: boolean;
  payoutConfiguration: {
    type: "equal_shares" | "proportion_drawing_specific" | "proportion_all_drawings";
  };
  thresholdRule: {
    thresholdAmount: number;
    method: "pooled" | "individual";
  };
}

export interface UserClubSummary {
  id: string;
  name: string;
  visibility: "public" | "private";
  role: "creator" | "admin" | "member";
}

export type ClubDiscoverySummary =
  | {
      id: string;
      name: string;
      visibility: "private";
      membershipStatus: MembershipStatus | null;
    }
  | {
      id: string;
      name: string;
      visibility: "public";
      description: string | null;
      motto: string | null;
      memberCount: number;
      membershipStatus: MembershipStatus | null;
    };

export interface MembershipRequestView {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  requestedAt: string;
}

export interface MembershipActionResult {
  membershipId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
}

export type UpdateNotificationPreferencesRequest = Pick<NotificationPreference, "inAppEnabled" | "emailEnabled">;

export interface UpdateClubSettingsRequest {
  name: string;
  description: string | null;
  motto: string | null;
  visibility: "public" | "private";
  allowSearch: boolean;
}

export interface RecalculationTarget {
  drawingId: string;
  cutoffAt: string;
}

export interface UpdateContributionRepositoryResult {
  contribution: Contribution;
  recalculationTargets: RecalculationTarget[];
}

export interface UpdateContributionResult {
  contribution: Contribution;
  recalculatedDrawingCount: number;
  recalculationPending: boolean;
}