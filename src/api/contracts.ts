import type {
  Club,
  ClubMembership,
  Contribution,
  Drawing,
  DrawingResult,
  LotteryType,
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
}

export type CreateContributionInput = {
  lottery: LotteryType;
  drawingDate: string;
  drawingCount: number;
} & (TicketNumberSetInput & { numberSets?: never } | { numberSets: TicketNumberSetInput[]; numbers?: never; bonusNumber?: never });

export interface TicketDrawingOption {
  lottery: LotteryType;
  drawingDate: string;
  maxDrawingCount: number;
  ticketPrice: number | null;
  numberRules: {
    mainNumberCount: number;
    mainNumberMin: number;
    mainNumberMax: number;
    bonusNumberMin: number;
    bonusNumberMax: number;
  } | null;
}