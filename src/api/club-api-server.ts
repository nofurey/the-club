import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";

import type { Contribution, Drawing, LotteryType, User } from "../domain";
import type { ClubOverview, CreateClubRequest, CreateContributionInput, TicketDrawingOption, UpdateClubSettingsRequest, UserClubSummary } from "./contracts";
import { LotteryTypeSchema } from "../validators";
import { ClubApiError } from "./errors";
import type { OidcIdentity, OidcTokenVerifier } from "./oidc-auth";
import { getMaxNumberSets, isAllowedDrawingCount } from "../services/drawing-schedule";

export interface ClubApiRepository {
  provisionOidcUser(identity: OidcIdentity): Promise<User>;
  listUserClubs(userId: string): Promise<UserClubSummary[]>;
  updateClubSettings(userId: string, clubId: string, input: UpdateClubSettingsRequest): Promise<import("../domain").Club | null>;
  createClub(userId: string, input: CreateClubRequest): Promise<{ id: string }>;
  getClubOverview(userId: string, clubId: string): Promise<ClubOverview | null>;
  ensureUpcomingDrawings(userId: string, clubId: string): Promise<Drawing[] | null>;
  getTicketDrawingOptions(userId: string, clubId: string): Promise<TicketDrawingOption[] | null>;
  createContribution(userId: string, clubId: string, input: CreateContributionInput, photo?: TicketPhoto): Promise<Contribution>;
    updateContribution(userId: string, clubId: string, contributionId: string, input: CreateContributionInput): Promise<Contribution>;
  getContributionPhoto(userId: string, clubId: string, contributionId: string): Promise<TicketPhoto | null>;
}

export interface TicketPhoto {
  data: Buffer;
  contentType: string;
}

export interface ClubApiServerOptions {
  repository: ClubApiRepository;
  verifyToken: OidcTokenVerifier;
  webOrigin: string;
  prepareTicketDrawings?: (userId: string, clubId: string, drawings: Drawing[]) => Promise<void>;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    authenticatedUser: User | null;
  }
}

const clubParamsSchema = z.object({ clubId: z.string().uuid() });
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
}).strict().refine((input) => new Set(input.numbers).size === input.numbers.length, {
  message: "Main numbers must be unique.",
});
const createContributionSchema = z.union([
  z.object({ ...contributionFields, numbers: z.array(z.number().int()).length(5), bonusNumber: z.number().int().min(1) }).strict().refine((input) => new Set(input.numbers).size === input.numbers.length),
  z.object({ ...contributionFields, numberSets: z.array(numberSetSchema).min(1).max(getMaxNumberSets("powerball")) }).strict(),
]).refine((input) => isAllowedDrawingCount(input.lottery, input.drawingCount), {
  message: "The selected number of drawings is not available for this lottery.",
});

function missingOfficialDataByLottery(drawings: Drawing[], options: TicketDrawingOption[]): Drawing[] {
  const missing = new Map<LotteryType, Drawing>();
  for (const drawing of drawings) {
    const option = options.find((item) => item.lottery === drawing.lottery && item.drawingDate === drawing.drawingDate);
    if ((!option?.numberRules || option.ticketPrice == null) && !missing.has(drawing.lottery)) missing.set(drawing.lottery, drawing);
  }
  return [...missing.values()];
}

export async function buildClubApiServer({ repository, verifyToken, webOrigin, prepareTicketDrawings, logger = false }: ClubApiServerOptions): Promise<FastifyInstance> {
  const server = Fastify({ logger, trustProxy: false, bodyLimit: 16 * 1024 });
  server.decorateRequest("authenticatedUser", null);
  await server.register(cors, {
    origin: webOrigin,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
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
      identity = await verifyToken(authorization.slice("Bearer ".length));
    } catch (error) {
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

  server.get("/api/v1/me/clubs", { preHandler: authenticate }, async (request) => ({
    clubs: await repository.listUserClubs(request.authenticatedUser!.id),
  }));

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
    return repository.updateContribution(
      request.authenticatedUser!.id,
      params.data.clubId,
      params.data.contributionId,
      parsedBody.data
    );
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
