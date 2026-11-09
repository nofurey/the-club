import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";

import type { Contribution, User } from "../domain";
import type { ClubOverview, CreateContributionInput, TicketDrawingOption } from "./contracts";
import { LotteryTypeSchema } from "../validators";
import { ClubApiError } from "./errors";
import type { OidcIdentity, OidcTokenVerifier } from "./oidc-auth";

export interface ClubApiRepository {
  provisionOidcUser(identity: OidcIdentity): Promise<User>;
  getClubOverview(userId: string, clubId: string): Promise<ClubOverview | null>;
  getTicketDrawingOptions(userId: string, clubId: string): Promise<TicketDrawingOption[] | null>;
  createContribution(userId: string, clubId: string, input: CreateContributionInput, photo?: TicketPhoto): Promise<Contribution>;
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
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    authenticatedUser: User | null;
  }
}

const clubParamsSchema = z.object({ clubId: z.string().uuid() });
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
  z.object({ ...contributionFields, numberSets: z.array(numberSetSchema).min(1).max(20) }).strict(),
]);

export async function buildClubApiServer({ repository, verifyToken, webOrigin, logger = false }: ClubApiServerOptions): Promise<FastifyInstance> {
  const server = Fastify({ logger, trustProxy: false, bodyLimit: 16 * 1024 });
  server.decorateRequest("authenticatedUser", null);
  await server.register(cors, {
    origin: webOrigin,
    methods: ["GET", "POST", "OPTIONS"],
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
    const options = await repository.getTicketDrawingOptions(request.authenticatedUser!.id, params.data.clubId);
    if (!options) {
      throw new ClubApiError(404, "Club was not found or the user is not an active member.", "club_not_found");
    }
    return options;
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

  server.get<{ Params: { clubId: string; contributionId: string } }>("/api/v1/clubs/:clubId/contributions/:contributionId/photo", { preHandler: authenticate }, async (request, reply) => {
    const params = clubParamsSchema.extend({ contributionId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new ClubApiError(400, "Valid club and contribution IDs are required.", "invalid_id");
    const photo = await repository.getContributionPhoto(request.authenticatedUser!.id, params.data.clubId, params.data.contributionId);
    if (!photo) throw new ClubApiError(404, "Ticket photo not found.", "photo_not_found");
    return reply.type(photo.contentType).header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff").send(photo.data);
  });

  return server;
}
