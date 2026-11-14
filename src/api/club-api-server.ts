import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";

import type { Contribution, Drawing, LotteryType, Notification, NotificationPreference, User } from "../domain";
import type { ClubDiscoverySummary, ClubOverview, CreateClubRequest, CreateContributionInput, MembershipActionResult, MembershipRequestView, RecalculationTarget, TicketDrawingOption, UpdateClubSettingsRequest, UpdateContributionRepositoryResult, UpdateNotificationPreferencesRequest, UserClubSummary } from "./contracts";
import { LotteryTypeSchema } from "../validators";
import { ClubApiError } from "./errors";
import { OidcEmailVerificationRequiredError, OidcProfileIncompleteError, type OidcIdentity, type OidcTokenVerifier } from "./oidc-auth";
import { getMaxNumberSets, isAllowedDrawingCount } from "../services/drawing-schedule";
import { hasValidPlayOptions } from "../services/ticket-options";

export interface ClubApiRepository {
  provisionOidcUser(identity: OidcIdentity): Promise<User>;
  listNotifications(userId: string): Promise<Notification[]>;
  getNotificationPreferences(userId: string): Promise<NotificationPreference>;
  updateNotificationPreferences(userId: string, input: UpdateNotificationPreferencesRequest): Promise<NotificationPreference>;
  markNotificationRead(userId: string, notificationId: string): Promise<boolean>;
  closeAccount(userId: string): Promise<void>;
  listUserClubs(userId: string): Promise<UserClubSummary[]>;
  searchClubs(userId: string, query: string): Promise<ClubDiscoverySummary[]>;
  requestMembership(userId: string, clubId: string): Promise<MembershipActionResult>;
  listMembershipRequests(userId: string, clubId: string): Promise<MembershipRequestView[]>;
  approveMembership(userId: string, clubId: string, memberUserId: string): Promise<MembershipActionResult>;
  rejectMembership(userId: string, clubId: string, memberUserId: string): Promise<MembershipActionResult>;
  leaveClub(userId: string, clubId: string): Promise<MembershipActionResult>;
  removeMember(userId: string, clubId: string, memberUserId: string): Promise<MembershipActionResult>;
  updateMembershipRole(userId: string, clubId: string, memberUserId: string, role: "admin" | "member"): Promise<MembershipActionResult>;
  closeClub(userId: string, clubId: string): Promise<void>;
  transferClubOwnership(userId: string, clubId: string, newOwnerUserId: string): Promise<void>;
  updateClubSettings(userId: string, clubId: string, input: UpdateClubSettingsRequest): Promise<import("../domain").Club | null>;
  createClub(userId: string, input: CreateClubRequest): Promise<{ id: string }>;
  getClubOverview(userId: string, clubId: string): Promise<ClubOverview | null>;
  ensureUpcomingDrawings(userId: string, clubId: string): Promise<Drawing[] | null>;
  getTicketDrawingOptions(userId: string, clubId: string): Promise<TicketDrawingOption[] | null>;
  createContribution(userId: string, clubId: string, input: CreateContributionInput, photo?: TicketPhoto): Promise<Contribution>;
    updateContribution(userId: string, clubId: string, contributionId: string, input: CreateContributionInput): Promise<UpdateContributionRepositoryResult>;
  getContributionPhoto(userId: string, clubId: string, contributionId: string): Promise<TicketPhoto | null>;
}

export interface TicketPhoto {
  data: Buffer;
  contentType: string;
}

export interface ClubApiServerOptions {
  repository: ClubApiRepository;
  verifyToken: OidcTokenVerifier;
  webOrigin: string | string[];
  prepareTicketDrawings?: (userId: string, clubId: string, drawings: Drawing[]) => Promise<void>;
  recalculateDrawings?: (clubId: string, targets: RecalculationTarget[]) => Promise<void>;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    authenticatedUser: User | null;
  }
}

const clubParamsSchema = z.object({ clubId: z.string().uuid() });
const clubMemberParamsSchema = z.object({ clubId: z.string().uuid(), userId: z.string().uuid() });
const discoveryQuerySchema = z.object({ q: z.string().trim().min(2).max(80) }).strict();
const membershipRoleSchema = z.object({ role: z.enum(["admin", "member"]) }).strict();
const notificationPreferencesSchema = z.object({ inAppEnabled: z.boolean(), emailEnabled: z.boolean() }).strict();
const notificationParamsSchema = z.object({ notificationId: z.string().uuid() });
const ownershipTransferSchema = z.object({ newOwnerUserId: z.string().uuid() }).strict();
const updateClubSettingsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable(),
  motto: z.string().trim().max(200).nullable(),
  visibility: z.enum(["public", "private"]),
  allowSearch: z.boolean(),
}).strict();
const createClubSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  motto: z.string().trim().max(200).nullable().optional(),
  visibility: z.enum(["public", "private"]),
  supportedLotteries: z.array(LotteryTypeSchema).min(1).max(2).refine((lotteries) => new Set(lotteries).size === lotteries.length),
  allowSearch: z.boolean().optional(),
  payoutConfiguration: z.object({ type: z.enum(["equal_shares", "proportion_drawing_specific", "proportion_all_drawings"]) }).strict(),
  thresholdRule: z.object({ thresholdAmount: z.number().finite().positive().max(1_000_000_000), method: z.enum(["pooled", "individual"]) }).strict(),
}).strict();
const contributionFields = {
  lottery: LotteryTypeSchema,
  drawingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  drawingCount: z.number().int().min(1).max(30),
};
const numberSetSchema = z.object({
  numbers: z.array(z.number().int()).length(5),
  bonusNumber: z.number().int().min(1),
  powerPlay: z.boolean().optional(),
  doublePlay: z.boolean().optional(),
  megaplier: z.number().int().optional(),
}).strict().refine((input) => new Set(input.numbers).size === input.numbers.length, {
  message: "Main numbers must be unique.",
});
const createContributionSchema = z.union([
  z.object({ ...contributionFields, numbers: z.array(z.number().int()).length(5), bonusNumber: z.number().int().min(1) }).strict().refine((input) => new Set(input.numbers).size === input.numbers.length),
  z.object({ ...contributionFields, numberSets: z.array(numberSetSchema).min(1).max(getMaxNumberSets("powerball")) }).strict(),
]).refine((input) => isAllowedDrawingCount(input.lottery, input.drawingCount), {
  message: "The selected number of drawings is not available for this lottery.",
}).refine((input) => ("numberSets" in input ? input.numberSets : [{}]).every((play) => hasValidPlayOptions(input.lottery, play)), {
  message: "Each play must use only the add-ons its lottery offers; Mega Millions plays require a multiplier.",
});

function missingOfficialDataByLottery(drawings: Drawing[], options: TicketDrawingOption[]): Drawing[] {
  const missing = new Map<LotteryType, Drawing>();
  for (const drawing of drawings) {
    const option = options.find((item) => item.lottery === drawing.lottery && item.drawingDate === drawing.drawingDate);
    if ((!option?.numberRules || option.ticketPrice == null) && !missing.has(drawing.lottery)) missing.set(drawing.lottery, drawing);
  }
  return [...missing.values()];
}

export async function buildClubApiServer({ repository, verifyToken, webOrigin, prepareTicketDrawings, recalculateDrawings, logger = false }: ClubApiServerOptions): Promise<FastifyInstance> {
  const server = Fastify({ logger, trustProxy: false, bodyLimit: 16 * 1024 });
  server.decorateRequest("authenticatedUser", null);
  await server.register(cors, {
    origin: webOrigin,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Identity-Token"],
    maxAge: 600,
  });
  await server.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2, fieldSize: 16 * 1024 } });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ClubApiError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_request", message: "Request validation failed." });
    }
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "invalid_request", message: "The request could not be processed." });
    }
    request.log.error({ err: error }, "Unhandled API error");
    return reply.code(500).send({ error: "internal_error", message: "The request could not be completed." });
  });

  const authenticate: preHandlerHookHandler = async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized", message: "A bearer access token is required." });
    }

    let identity: OidcIdentity;
    try {
      const identityToken = request.headers["x-identity-token"];
      identity = await verifyToken(
        authorization.slice("Bearer ".length),
        typeof identityToken === "string" ? identityToken : undefined
      );
    } catch (error) {
      if (error instanceof OidcEmailVerificationRequiredError) {
        return reply.code(403).send({ error: "email_verification_required", message: error.message });
      }
      if (error instanceof OidcProfileIncompleteError) {
        return reply.code(403).send({ error: "profile_incomplete", message: error.message });
      }
      request.log.warn({
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "Token verification failed.",
      }, "OIDC bearer token rejected");
      return reply.code(401).send({ error: "unauthorized", message: "The access token is invalid or expired." });
    }

    try {
      const user = await repository.provisionOidcUser(identity);
      if (user.status !== "active") {
        return reply.code(403).send({ error: "account_inactive", message: "This account is not active." });
      }
      request.authenticatedUser = user;
    } catch (error) {
      if (error instanceof ClubApiError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      request.log.warn({ err: error }, "OIDC user provisioning failed");
      return reply.code(500).send({ error: "user_provisioning_failed", message: "The authenticated user could not be loaded." });
    }
  };

  server.get("/health", async () => ({ status: "ok" }));

  server.get("/api/v1/me", { preHandler: authenticate }, async (request) => ({
    user: request.authenticatedUser,
  }));

  server.get("/api/v1/me/notifications", { preHandler: authenticate }, async (request) => ({
    notifications: await repository.listNotifications(request.authenticatedUser!.id),
  }));

  server.get("/api/v1/me/notification-preferences", { preHandler: authenticate }, async (request) => ({
    preferences: await repository.getNotificationPreferences(request.authenticatedUser!.id),
  }));

  server.patch<{ Body: unknown }>("/api/v1/me/notification-preferences", { preHandler: authenticate }, async (request) => {
    const body = notificationPreferencesSchema.safeParse(request.body);
    if (!body.success) throw new ClubApiError(400, "Notification preferences are invalid.", "invalid_notification_preferences");
    return { preferences: await repository.updateNotificationPreferences(request.authenticatedUser!.id, body.data) };
  });

  server.post<{ Params: { notificationId: string } }>("/api/v1/me/notifications/:notificationId/read", { preHandler: authenticate }, async (request, reply) => {
    const params = notificationParamsSchema.safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "A valid notification ID is required.", "invalid_notification_id");
    if (!await repository.markNotificationRead(request.authenticatedUser!.id, params.data.notificationId)) {
      throw new ClubApiError(404, "Notification was not found.", "notification_not_found");
    }
    return reply.code(204).send();
  });

  server.get("/api/v1/me/clubs", { preHandler: authenticate }, async (request) => ({
    clubs: await repository.listUserClubs(request.authenticatedUser!.id),
  }));

  server.post("/api/v1/me/close", { preHandler: authenticate }, async (request, reply) => {
    await repository.closeAccount(request.authenticatedUser!.id);
    return reply.code(204).send();
  });

  server.get<{ Querystring: { q?: string } }>("/api/v1/clubs/discovery", { preHandler: authenticate }, async (request) => {
    const parsedQuery = discoveryQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) throw new ClubApiError(400, "Enter at least two characters to search clubs.", "invalid_discovery_query");
    return { clubs: await repository.searchClubs(request.authenticatedUser!.id, parsedQuery.data.q) };
  });

  server.post<{ Params: { clubId: string } }>("/api/v1/clubs/:clubId/membership", { preHandler: authenticate }, async (request, reply) => {
    const params = clubParamsSchema.safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "A valid club ID is required.", "invalid_club_id");
    return reply.code(201).send({ membership: await repository.requestMembership(request.authenticatedUser!.id, params.data.clubId) });
  });

  server.get<{ Params: { clubId: string } }>("/api/v1/clubs/:clubId/membership-requests", { preHandler: authenticate }, async (request) => {
    const params = clubParamsSchema.safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "A valid club ID is required.", "invalid_club_id");
    return { requests: await repository.listMembershipRequests(request.authenticatedUser!.id, params.data.clubId) };
  });

  server.post<{ Params: { clubId: string; userId: string } }>("/api/v1/clubs/:clubId/membership-requests/:userId/approve", { preHandler: authenticate }, async (request) => {
    const params = clubMemberParamsSchema.safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "Valid club and member IDs are required.", "invalid_membership_id");
    return { membership: await repository.approveMembership(request.authenticatedUser!.id, params.data.clubId, params.data.userId) };
  });

  server.post<{ Params: { clubId: string; userId: string } }>("/api/v1/clubs/:clubId/membership-requests/:userId/reject", { preHandler: authenticate }, async (request) => {
    const params = clubMemberParamsSchema.safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "Valid club and member IDs are required.", "invalid_membership_id");
    return { membership: await repository.rejectMembership(request.authenticatedUser!.id, params.data.clubId, params.data.userId) };
  });

  server.post<{ Params: { clubId: string } }>("/api/v1/clubs/:clubId/leave", { preHandler: authenticate }, async (request) => {
    const params = clubParamsSchema.safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "A valid club ID is required.", "invalid_club_id");
    return { membership: await repository.leaveClub(request.authenticatedUser!.id, params.data.clubId) };
  });

  server.post<{ Params: { clubId: string } }>("/api/v1/clubs/:clubId/close", { preHandler: authenticate }, async (request, reply) => {
    const params = clubParamsSchema.safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "A valid club ID is required.", "invalid_club_id");
    await repository.closeClub(request.authenticatedUser!.id, params.data.clubId);
    return reply.code(204).send();
  });

  server.post<{ Params: { clubId: string }; Body: unknown }>("/api/v1/clubs/:clubId/transfer-ownership", { preHandler: authenticate }, async (request, reply) => {
    const params = clubParamsSchema.safeParse(request.params);
    const body = ownershipTransferSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new ClubApiError(400, "Ownership transfer details are invalid.", "invalid_ownership_transfer");
    await repository.transferClubOwnership(request.authenticatedUser!.id, params.data.clubId, body.data.newOwnerUserId);
    return reply.code(204).send();
  });

  server.post<{ Params: { clubId: string; userId: string } }>("/api/v1/clubs/:clubId/members/:userId/remove", { preHandler: authenticate }, async (request) => {
    const params = clubMemberParamsSchema.safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "Valid club and member IDs are required.", "invalid_membership_id");
    return { membership: await repository.removeMember(request.authenticatedUser!.id, params.data.clubId, params.data.userId) };
  });

  server.patch<{ Params: { clubId: string; userId: string }; Body: unknown }>("/api/v1/clubs/:clubId/members/:userId/role", { preHandler: authenticate }, async (request) => {
    const params = clubMemberParamsSchema.safeParse(request.params);
    const body = membershipRoleSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new ClubApiError(400, "Membership role update is invalid.", "invalid_membership_role");
    return { membership: await repository.updateMembershipRole(request.authenticatedUser!.id, params.data.clubId, params.data.userId, body.data.role) };
  });

  server.post<{ Body: unknown }>("/api/v1/clubs", { preHandler: authenticate }, async (request, reply) => {
    const parsedBody = createClubSchema.safeParse(request.body);
    if (!parsedBody.success) throw new ClubApiError(400, "Club configuration is invalid.", "invalid_club");
    const userId = request.authenticatedUser!.id;
    const created = await repository.createClub(userId, parsedBody.data);
    const drawings = await repository.ensureUpcomingDrawings(userId, created.id);
    if (!drawings) throw new ClubApiError(500, "The new club schedule could not be initialized.", "schedule_initialization_failed");
    const options = await repository.getTicketDrawingOptions(userId, created.id);
    if (!options) throw new ClubApiError(500, "The new club ticket options could not be loaded.", "ticket_options_unavailable");
    const missingOfficialData = missingOfficialDataByLottery(drawings, options);
    if (missingOfficialData.length && prepareTicketDrawings) {
      try {
        await prepareTicketDrawings(userId, created.id, missingOfficialData);
      } catch (error) {
        request.log.warn({ errorName: error instanceof Error ? error.name : "UnknownError" }, "New club official ticket rules could not be fully refreshed");
      }
    }
    const overview = await repository.getClubOverview(userId, created.id);
    if (!overview) throw new ClubApiError(500, "The new club could not be loaded.", "club_overview_unavailable");
    return reply.code(201).send(overview);
  });

  server.patch<{ Params: { clubId: string }; Body: unknown }>("/api/v1/clubs/:clubId/settings", { preHandler: authenticate }, async (request) => {
    const params = clubParamsSchema.safeParse(request.params);
    const parsedBody = updateClubSettingsSchema.safeParse(request.body);
    if (!params.success || !parsedBody.success) throw new ClubApiError(400, "Club settings are invalid.", "invalid_club_settings");
    const club = await repository.updateClubSettings(request.authenticatedUser!.id, params.data.clubId, parsedBody.data);
    if (!club) throw new ClubApiError(404, "Club was not found or the user is not an active member.", "club_not_found");
    return { club };
  });

  server.get<{ Params: { clubId: string } }>("/api/v1/clubs/:clubId/overview", { preHandler: authenticate }, async (request) => {
    const params = clubParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ClubApiError(400, "A valid club ID is required.", "invalid_club_id");
    }
    const overview = await repository.getClubOverview(request.authenticatedUser!.id, params.data.clubId);
    if (!overview) {
      throw new ClubApiError(404, "Club was not found or the user is not an active member.", "club_not_found");
    }
    return overview;
  });

  server.get<{ Params: { clubId: string } }>("/api/v1/clubs/:clubId/ticket-drawings", { preHandler: authenticate }, async (request) => {
    const params = clubParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ClubApiError(400, "A valid club ID is required.", "invalid_club_id");
    }
    const userId = request.authenticatedUser!.id;
    const drawings = await repository.ensureUpcomingDrawings(userId, params.data.clubId);
    if (!drawings) {
      throw new ClubApiError(404, "Club was not found or the user is not an active member.", "club_not_found");
    }
    const options = await repository.getTicketDrawingOptions(userId, params.data.clubId);
    if (!options) {
      throw new ClubApiError(404, "Club was not found or the user is not an active member.", "club_not_found");
    }
    const missingOfficialData = missingOfficialDataByLottery(drawings, options);
    if (missingOfficialData.length && prepareTicketDrawings) {
      try {
        await prepareTicketDrawings(userId, params.data.clubId, missingOfficialData);
      } catch (error) {
        request.log.warn({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Upcoming official ticket rules could not be fully refreshed");
      }
    }
    const refreshedOptions = await repository.getTicketDrawingOptions(userId, params.data.clubId);
    if (!refreshedOptions) {
      throw new ClubApiError(404, "Club was not found or the user is not an active member.", "club_not_found");
    }
    return refreshedOptions;
  });

  server.post<{ Params: { clubId: string }; Body: unknown }>("/api/v1/clubs/:clubId/contributions", { preHandler: authenticate }, async (request, reply) => {
    const params = clubParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ClubApiError(400, "A valid club ID is required.", "invalid_club_id");
    }
    let body = request.body;
    let photo: TicketPhoto | undefined;
    if (request.isMultipart()) {
      let contributionJson: string | undefined;
      for await (const part of request.parts()) {
        if (part.type === "field" && part.fieldname === "contribution" && typeof part.value === "string" && !part.valueTruncated) {
          contributionJson = part.value;
        } else if (part.type === "file" && part.fieldname === "photo") {
          const data = await part.toBuffer();
          let detected;
          try { detected = await fileTypeFromBuffer(data); } catch { detected = undefined; }
          if (!detected || !["image/jpeg", "image/png", "image/webp"].includes(detected.mime)) {
            throw new ClubApiError(400, "Ticket photos must be JPEG, PNG, or WebP images.", "invalid_photo");
          }
          photo = { data, contentType: detected.mime };
        } else {
          throw new ClubApiError(400, "Invalid contribution upload.", "invalid_contribution");
        }
      }
      try { body = JSON.parse(contributionJson ?? ""); } catch {
        throw new ClubApiError(400, "Contribution data is invalid.", "invalid_contribution");
      }
    }
    const parsedBody = createContributionSchema.safeParse(body);
    if (!parsedBody.success) {
      throw new ClubApiError(400, "Contribution data is invalid.", "invalid_contribution");
    }
    const contribution = await repository.createContribution(
      request.authenticatedUser!.id,
      params.data.clubId,
      parsedBody.data,
      photo
    );
    return reply.code(201).send(contribution);
  });

  server.patch<{ Params: { clubId: string; contributionId: string }; Body: unknown }>('/api/v1/clubs/:clubId/contributions/:contributionId', { preHandler: authenticate }, async (request) => {
    const params = clubParamsSchema.extend({ contributionId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "Valid club and contribution IDs are required.", "invalid_id");
    const parsedBody = createContributionSchema.safeParse(request.body);
    if (!parsedBody.success) throw new ClubApiError(400, "Contribution data is invalid.", "invalid_contribution");
    const updated = await repository.updateContribution(
      request.authenticatedUser!.id,
      params.data.clubId,
      params.data.contributionId,
      parsedBody.data
    );
    let recalculationPending = updated.recalculationTargets.length > 0;
    let recalculatedDrawingCount = 0;
    if (recalculationPending && recalculateDrawings) {
      try {
        await recalculateDrawings(params.data.clubId, updated.recalculationTargets);
        recalculatedDrawingCount = updated.recalculationTargets.length;
        recalculationPending = false;
      } catch (error) {
        request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Ticket edit recalculation failed");
      }
    }
    return {
      contribution: updated.contribution,
      recalculatedDrawingCount,
      recalculationPending,
    };
  });

  server.get<{ Params: { clubId: string; contributionId: string } }>("/api/v1/clubs/:clubId/contributions/:contributionId/photo", { preHandler: authenticate }, async (request, reply) => {
    const params = clubParamsSchema.extend({ contributionId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "Valid club and contribution IDs are required.", "invalid_id");
    const photo = await repository.getContributionPhoto(request.authenticatedUser!.id, params.data.clubId, params.data.contributionId);
    if (!photo) throw new ClubApiError(404, "Ticket photo not found.", "photo_not_found");
    return reply.type(photo.contentType).header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").send(photo.data);
  });

  return server;
}
