import { z } from "zod";

export const ClubVisibilitySchema = z.enum(["public", "private"]);
export const ClubStatusSchema = z.enum(["active", "closed"]);
export const MembershipRoleSchema = z.enum(["creator", "admin", "member"]);
export const MembershipStatusSchema = z.enum(["pending", "active", "removed"]);
export const PayoutTypeSchema = z.enum([
  "equal_shares",
  "proportion_drawing_specific",
  "proportion_all_drawings",
]);
export const ThresholdMethodSchema = z.enum(["pooled", "individual"]);
export const LotteryTypeSchema = z.enum(["powerball", "mega_millions"]);
export const ContributionStatusSchema = z.enum([
  "draft",
  "submitted",
  "calculated",
  "recalculated",
  "archived",
]);
export const DrawingStatusSchema = z.enum([
  "pending",
  "results_posted",
  "calculated",
  "recalculated",
]);
export const NotificationChannelSchema = z.enum([
  "in_app",
  "email",
  "push",
  "sms",
]);
export const NotificationStatusSchema = z.enum(["queued", "sent", "failed"]);
export const FlagStatusSchema = z.enum([
  "open",
  "verified",
  "escalated",
  "resolved",
]);
export const PrizeAwardStatusSchema = z.enum([
  "pending",
  "allocated",
  "recalculated",
]);

export const UserSchema = z.object({
  id: z.string().uuid(),
  authSubject: z.string().min(1).nullable().optional(),
  email: z.string().email(),
  displayName: z.string().trim().min(1),
  username: z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9._-]+$/).nullable().optional(),
  firstName: z.string().trim().min(1).max(100).nullable().optional(),
  lastName: z.string().trim().min(1).max(100).nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
  isPhoneVerified: z.boolean().default(false),
  status: z.enum(["active", "closed"]).default("active"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable().optional(),
});

export const ClubSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().nullable().optional(),
  motto: z.string().nullable().optional(),
  visibility: ClubVisibilitySchema,
  ownerUserId: z.string().uuid(),
  status: ClubStatusSchema.default("active"),
  payoutConfigurationId: z.string().uuid().nullable().optional(),
  thresholdRuleId: z.string().uuid().nullable().optional(),
  supportedLotteries: z.array(LotteryTypeSchema).min(1),
  allowSearch: z.boolean().default(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable().optional(),
});

export const ClubMembershipSchema = z.object({
  id: z.string().uuid(),
  clubId: z.string().uuid(),
  userId: z.string().uuid(),
  role: MembershipRoleSchema,
  status: MembershipStatusSchema.default("pending"),
  joinedAt: z.string().datetime(),
  approvedAt: z.string().datetime().nullable().optional(),
  removedAt: z.string().datetime().nullable().optional(),
  removedByUserId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const PayoutConfigurationSchema = z.object({
  id: z.string().uuid(),
  clubId: z.string().uuid(),
  type: PayoutTypeSchema,
  version: z.number().int().min(1),
  createdAt: z.string().datetime(),
});

export const ThresholdRuleSchema = z.object({
  id: z.string().uuid(),
  clubId: z.string().uuid(),
  thresholdAmount: z.number().positive(),
  method: ThresholdMethodSchema,
  createdAt: z.string().datetime(),
});

export const NumberSetSchema = z.object({
  id: z.string().uuid(),
  contributionId: z.string().uuid(),
  numbers: z.array(z.number().int()).min(1),
  bonusNumber: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
});

export const ContributionSchema = z.object({
  id: z.string().uuid(),
  clubId: z.string().uuid(),
  userId: z.string().uuid(),
  lottery: LotteryTypeSchema,
  drawingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  drawingCount: z.number().int().min(1),
  numberSets: z.array(z.unknown()).min(1),
  ticketImageUrl: z.string().url().nullable().optional(),
  hasTicketPhoto: z.boolean().optional(),
  canEdit: z.boolean().optional(),
  costUsd: z.number().positive(),
  status: ContributionStatusSchema.default("submitted"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().min(1),
});

export const DrawingSchema = z.object({
  id: z.string().uuid(),
  lottery: LotteryTypeSchema,
  drawingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  state: z.string().min(1),
  cutoffTimeEt: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  officialResultPostedAt: z.string().datetime().nullable().optional(),
  estimatedJackpot: z.number().nonnegative().nullable().optional(),
  cashValue: z.number().nonnegative().nullable().optional(),
  drawingSizeSourceUrl: z.string().url().nullable().optional(),
  drawingSizeSourceContentType: z.string().nullable().optional(),
  drawingSizeSourceDocument: z.string().nullable().optional(),
  drawingSizeSourceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  drawingSizeCapturedAt: z.string().datetime().nullable().optional(),
  status: DrawingStatusSchema.default("pending"),
  createdAt: z.string().datetime(),
});

export const CalculationSnapshotSchema = z.object({
  id: z.string().uuid(),
  drawingId: z.string().uuid(),
  clubId: z.string().uuid(),
  lottery: LotteryTypeSchema,
  rulesUrl: z.string().url(),
  rulesVersion: z.string().min(1),
  priceSnapshot: z.record(z.string(), z.any()),
  capturedAt: z.string().datetime(),
  sourceContentType: z.string().nullable().optional(),
  sourceDocument: z.string().nullable().optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  sourceDocumentUrl: z.string().url().nullable().optional(),
});

export const DrawingResultSchema = z.object({
  id: z.string().uuid(),
  drawingId: z.string().uuid(),
  clubId: z.string().uuid(),
  officialWinningNumbers: z.record(z.string(), z.any()).nullable().optional(),
  jackpotEstimate: z.number().nonnegative().nullable().optional(),
  prizeBreakdown: z.record(z.string(), z.any()).nullable().optional(),
  status: DrawingStatusSchema.default("pending"),
  calculationStartedAt: z.string().datetime().nullable().optional(),
  calculatedAt: z.string().datetime().nullable().optional(),
  sourceSnapshotId: z.string().uuid().nullable().optional(),
  officialSourceUrl: z.string().url().nullable().optional(),
  officialSourceContentType: z.string().nullable().optional(),
  officialSourceDocument: z.string().nullable().optional(),
  officialSourceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  createdAt: z.string().datetime(),
});

export const PrizeAwardSchema = z.object({
  id: z.string().uuid(),
  drawingResultId: z.string().uuid(),
  contributionId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  clubId: z.string().uuid(),
  prizeType: z.string().min(1),
  grossPrizeAmount: z.number().nonnegative(),
  shareAmount: z.number().nonnegative(),
  thresholdMet: z.boolean(),
  payoutType: PayoutTypeSchema.nullable().optional(),
  status: PrizeAwardStatusSchema.default("pending"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const AuditEventSchema = z.object({
  id: z.string().uuid(),
  clubId: z.string().uuid(),
  actorUserId: z.string().uuid().nullable().optional(),
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
  action: z.string().min(1),
  oldValue: z.record(z.string(), z.any()).nullable().optional(),
  newValue: z.record(z.string(), z.any()).nullable().optional(),
  occurredAt: z.string().datetime(),
});

export const NotificationPreferenceSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  inAppEnabled: z.boolean().default(true),
  emailEnabled: z.boolean().default(true),
  pushEnabled: z.boolean().default(false),
  smsEnabled: z.boolean().default(false),
  phoneVerified: z.boolean().default(false),
  updatedAt: z.string().datetime(),
});

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  clubId: z.string().uuid(),
  drawingId: z.string().uuid().nullable().optional(),
  type: z.string().min(1),
  channel: NotificationChannelSchema,
  status: NotificationStatusSchema.default("queued"),
  message: z.string().min(1),
  recalculationType: z.string().nullable().optional(),
  sentAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
});

export const FlagSchema = z.object({
  id: z.string().uuid(),
  clubId: z.string().uuid(),
  userId: z.string().uuid(),
  prizeAwardId: z.string().uuid(),
  reason: z.string().min(1),
  status: FlagStatusSchema.default("open"),
  escalatedToSupport: z.boolean().default(false),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable().optional(),
});

export function validateUser(input: unknown) {
  return UserSchema.parse(input);
}

export function validateClub(input: unknown) {
  return ClubSchema.parse(input);
}

export function validateMembership(input: unknown) {
  return ClubMembershipSchema.parse(input);
}

export function validateContribution(input: unknown) {
  return ContributionSchema.parse(input);
}

export function validateDrawingResult(input: unknown) {
  return DrawingResultSchema.parse(input);
}

export function validateNotification(input: unknown) {
  return NotificationSchema.parse(input);
}

export const safeValidateUser = (input: unknown) => UserSchema.safeParse(input);
export const safeValidateClub = (input: unknown) => ClubSchema.safeParse(input);
export const safeValidateMembership = (input: unknown) =>
  ClubMembershipSchema.safeParse(input);
export const safeValidateContribution = (input: unknown) =>
  ContributionSchema.safeParse(input);
export const safeValidateDrawingResult = (input: unknown) =>
  DrawingResultSchema.safeParse(input);
export const safeValidateNotification = (input: unknown) =>
  NotificationSchema.safeParse(input);
