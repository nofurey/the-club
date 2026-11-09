export type ClubVisibility = "public" | "private";
export type ClubStatus = "active" | "closed";
export type MembershipRole = "creator" | "admin" | "member";
export type MembershipStatus = "pending" | "active" | "removed";
export type PayoutType =
  | "equal_shares"
  | "proportion_drawing_specific"
  | "proportion_all_drawings";

export type ThresholdMethod = "pooled" | "individual";
export type LotteryType = "powerball" | "mega_millions";
export type ContributionStatus =
  | "draft"
  | "submitted"
  | "calculated"
  | "recalculated"
  | "archived";

export type DrawingStatus =
  | "pending"
  | "results_posted"
  | "calculated"
  | "recalculated";

export type NotificationChannel = "in_app" | "email" | "push" | "sms";
export type NotificationStatus = "queued" | "sent" | "failed";
export type FlagStatus = "open" | "verified" | "escalated" | "resolved";
export type PrizeAwardStatus = "pending" | "allocated" | "recalculated";

export interface User {
  id: string;
  email: string;
  displayName: string;
  phoneNumber?: string | null;
  isPhoneVerified: boolean;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

export interface Club {
  id: string;
  name: string;
  description?: string | null;
  motto?: string | null;
  visibility: ClubVisibility;
  ownerUserId: string;
  status: ClubStatus;
  payoutConfigurationId?: string | null;
  thresholdRuleId?: string | null;
  supportedLotteries: LotteryType[];
  allowSearch: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

export interface ClubMembership {
  id: string;
  clubId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: string;
  approvedAt?: string | null;
  removedAt?: string | null;
  removedByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayoutConfiguration {
  id: string;
  clubId: string;
  type: PayoutType;
  version: number;
  createdAt: string;
}

export interface ThresholdRule {
  id: string;
  clubId: string;
  thresholdAmount: number;
  method: ThresholdMethod;
  createdAt: string;
}

export interface NumberSet {
  id: string;
  contributionId: string;
  numbers: number[];
  bonusNumber?: string | null;
  createdAt: string;
}

export interface Contribution {
  id: string;
  clubId: string;
  userId: string;
  lottery: LotteryType;
  drawingDate: string;
  drawingCount: number;
  numberSets: NumberSet[] | Record<string, unknown>[];
  ticketImageUrl?: string | null;
  costUsd: number;
  status: ContributionStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface Drawing {
  id: string;
  lottery: LotteryType;
  drawingDate: string;
  state: string;
  cutoffTimeEt: string;
  officialResultPostedAt?: string | null;
  status: DrawingStatus;
  createdAt: string;
}

export interface CalculationSnapshot {
  id: string;
  drawingId: string;
  clubId: string;
  lottery: LotteryType;
  rulesUrl: string;
  rulesVersion: string;
  priceSnapshot: Record<string, unknown>;
  capturedAt: string;
  sourceContentType?: string | null;
  sourceDocument?: string | null;
  sourceSha256?: string | null;
  sourceDocumentUrl?: string | null;
}

export interface DrawingResult {
  id: string;
  drawingId: string;
  clubId: string;
  officialWinningNumbers?: Record<string, unknown> | null;
  jackpotEstimate?: number | null;
  prizeBreakdown?: Record<string, unknown> | null;
  status: DrawingStatus;
  calculationStartedAt?: string | null;
  calculatedAt?: string | null;
  sourceSnapshotId?: string | null;
  createdAt: string;
  officialSourceUrl?: string | null;
  officialSourceContentType?: string | null;
  officialSourceDocument?: string | null;
  officialSourceSha256?: string | null;
}

export interface PrizeAward {
  id: string;
  drawingResultId: string;
  contributionId?: string | null;
  userId?: string | null;
  clubId: string;
  prizeType: string;
  grossPrizeAmount: number;
  shareAmount: number;
  thresholdMet: boolean;
  payoutType?: PayoutType | null;
  status: PrizeAwardStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  clubId: string;
  actorUserId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  occurredAt: string;
}

export interface NotificationPreference {
  id: string;
  userId: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  smsEnabled: boolean;
  phoneVerified: boolean;
  updatedAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  clubId: string;
  drawingId?: string | null;
  type: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  message: string;
  recalculationType?: string | null;
  sentAt?: string | null;
  createdAt: string;
}

export interface Flag {
  id: string;
  clubId: string;
  userId: string;
  prizeAwardId: string;
  reason: string;
  status: FlagStatus;
  escalatedToSupport: boolean;
  createdAt: string;
  resolvedAt?: string | null;
}
