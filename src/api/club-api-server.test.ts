import assert from "node:assert/strict";
import test from "node:test";

import type { Club, Contribution, Drawing, User } from "../domain";
import type { ClubOverview, CreateClubRequest, MembershipActionResult, UpdateClubSettingsRequest } from "./contracts";
import type { ClubApiRepository, ClubApiServerOptions } from "./club-api-server";
import { buildClubApiServer } from "./club-api-server";
import { OidcEmailVerificationRequiredError } from "./oidc-auth";

const user: User = {
  id: "b1000000-0000-4000-8000-000000000001",
  authSubject: "oidc-subject-1",
  email: "member@example.test",
  displayName: "Club Member",
  phoneNumber: null,
  isPhoneVerified: false,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
};

const contribution: Contribution = {
  id: "b2000000-0000-4000-8000-000000000001",
  clubId: "b3000000-0000-4000-8000-000000000001",
  userId: user.id,
  lottery: "powerball",
  drawingDate: "2026-11-09",
  drawingCount: 1,
  numberSets: [{ numbers: [1, 2, 3, 4, 5], bonusNumber: "6" }],
  ticketImageUrl: null,
  costUsd: 2,
  status: "submitted",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  version: 1,
};

const club: Club = {
  id: contribution.clubId,
  name: "Test Club",
  description: null,
  motto: null,
  visibility: "private",
  ownerUserId: user.id,
  status: "active",
  payoutConfigurationId: "b5000000-0000-4000-8000-000000000001",
  thresholdRuleId: "b6000000-0000-4000-8000-000000000001",
  supportedLotteries: ["powerball"],
  allowSearch: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
};

function createRepository(): ClubApiRepository & { createdBy: string | null; updatedBy: string | null; membershipRequestedBy: string | null; accountClosedBy: string | null; clubClosedBy: string | null; ownershipTransferredBy: string | null; ownershipTarget: string | null } {
  return {
    createdBy: null,
    updatedBy: null,
    membershipRequestedBy: null,
    accountClosedBy: null,
    clubClosedBy: null,
    ownershipTransferredBy: null,
    ownershipTarget: null,
    async provisionOidcUser(identity) {
      assert.equal(identity.emailVerified, true);
      return user;
    },
    async listNotifications() { return []; },
    async getNotificationPreferences() {
      return { id: "b8000000-0000-4000-8000-000000000001", userId: user.id, inAppEnabled: true, emailEnabled: true, pushEnabled: false, smsEnabled: false, phoneVerified: false, updatedAt: "2026-01-01T00:00:00.000Z" };
    },
    async updateNotificationPreferences(userId, input) {
      return { id: "b8000000-0000-4000-8000-000000000001", userId, ...input, pushEnabled: false, smsEnabled: false, phoneVerified: false, updatedAt: "2026-01-01T00:00:00.000Z" };
    },
    async markNotificationRead() { return true; },
    async listUserClubs(userId) {
      return userId === user.id ? [{ id: club.id, name: club.name, visibility: club.visibility, role: "creator" }] : [];
    },
    async closeAccount(userId) { this.accountClosedBy = userId; },
    async closeClub(userId) { this.clubClosedBy = userId; },
    async transferClubOwnership(userId, _clubId, newOwnerUserId) {
      this.ownershipTransferredBy = userId;
      this.ownershipTarget = newOwnerUserId;
    },
    async searchClubs() {
      return [{ id: club.id, name: club.name, visibility: "private", membershipStatus: null }];
    },
    async requestMembership(userId) {
      this.membershipRequestedBy = userId;
      return { membershipId: "b4000000-0000-4000-8000-000000000001", userId, role: "member", status: "pending" };
    },
    async listMembershipRequests() { return []; },
    async approveMembership(): Promise<MembershipActionResult> { throw new Error("not implemented"); },
    async rejectMembership(): Promise<MembershipActionResult> { throw new Error("not implemented"); },
    async leaveClub(): Promise<MembershipActionResult> { throw new Error("not implemented"); },
    async removeMember(): Promise<MembershipActionResult> { throw new Error("not implemented"); },
    async updateMembershipRole(): Promise<MembershipActionResult> { throw new Error("not implemented"); },
    async updateClubSettings(userId, clubId, input) {
      return userId === user.id && clubId === club.id ? { ...club, ...input } : null;
    },
    async createClub() { return { id: contribution.clubId }; },
    async getClubOverview() { return null; },
    async ensureUpcomingDrawings(userId) {
      return userId === user.id ? [] : null;
    },
    async getTicketDrawingOptions(userId) {
      return userId === user.id ? [] : null;
    },
    async getContributionPhoto() { return null; },
    async createContribution(userId) {
      this.createdBy = userId;
      return contribution;
    },
    async updateContribution(userId, clubId, contributionId) {
      assert.equal(clubId, contribution.clubId);
      assert.equal(contributionId, contribution.id);
      this.updatedBy = userId;
      return { contribution: { ...contribution, version: contribution.version + 1 }, recalculationTargets: [] };
    },
  };
}

async function createServer(repository = createRepository(), prepareTicketDrawings?: ClubApiServerOptions["prepareTicketDrawings"]) {
  const server = await buildClubApiServer({
    repository,
    webOrigin: "https://club.example.test",
    prepareTicketDrawings,
    verifyToken: async (token) => {
      if (token !== "valid-token") throw new Error("invalid token");
      return {
        subject: user.authSubject!,
        email: user.email,
        emailVerified: true,
        displayName: user.displayName,
      };
    },
  });
  return { server, repository };
}

test("requires a bearer token before returning the authenticated user", async (t) => {
  const { server } = await createServer();
  t.after(() => server.close());

  const missing = await server.inject({ method: "GET", url: "/api/v1/me" });
  const invalid = await server.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: "Bearer bad-token" },
  });
  const valid = await server.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: "Bearer valid-token" },
  });

  assert.equal(missing.statusCode, 401);
  assert.equal(invalid.statusCode, 401);
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.json().user.id, user.id);
});

test("explains when a valid identity has not verified its email", async (t) => {
  const server = await buildClubApiServer({
    repository: createRepository(),
    webOrigin: "https://club.example.test",
    verifyToken: async () => { throw new OidcEmailVerificationRequiredError(); },
  });
  t.after(() => server.close());

  const response = await server.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: "Bearer valid-token" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "email_verification_required");
  assert.match(response.json().message, /verify your email/i);
});

test("lists the authenticated member's clubs and updates settings through the API", async (t) => {
  const { server, repository } = await createServer();
  t.after(() => server.close());
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/me/clubs" })).statusCode, 401);
  const listed = await server.inject({ method: "GET", url: "/api/v1/me/clubs", headers: { authorization: "Bearer valid-token" } });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().clubs.map((item: { id: string }) => item.id), [club.id]);

  const payload: UpdateClubSettingsRequest = { name: "Updated Club", description: "Updated", motto: "Together", visibility: "public", allowSearch: true };
  const url = `/api/v1/clubs/${club.id}/settings`;
  const updated = await server.inject({ method: "PATCH", url, headers: { authorization: "Bearer valid-token" }, payload });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().club.name, payload.name);
  assert.equal(updated.json().club.visibility, "public");
  repository.updateClubSettings = async () => null;
  assert.equal((await server.inject({ method: "PATCH", url, headers: { authorization: "Bearer valid-token" }, payload })).statusCode, 404);
});

test("notification inbox and preference actions use the authenticated user", async (t) => {
  const { server, repository } = await createServer();
  t.after(() => server.close());
  let updatedBy: string | null = null;
  let markedReadBy: string | null = null;
  repository.updateNotificationPreferences = async (userId, input) => {
    updatedBy = userId;
    return { id: "b8000000-0000-4000-8000-000000000001", userId, ...input, pushEnabled: false, smsEnabled: false, phoneVerified: false, updatedAt: "2026-01-01T00:00:00.000Z" };
  };
  repository.markNotificationRead = async (userId) => {
    markedReadBy = userId;
    return true;
  };

  assert.equal((await server.inject({ method: "GET", url: "/api/v1/me/notifications" })).statusCode, 401);
  const headers = { authorization: "Bearer valid-token" };
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/me/notifications", headers })).statusCode, 200);
  const preferences = await server.inject({
    method: "PATCH",
    url: "/api/v1/me/notification-preferences",
    headers,
    payload: { inAppEnabled: false, emailEnabled: true },
  });
  assert.equal(preferences.statusCode, 200);
  assert.equal(updatedBy, user.id);
  const read = await server.inject({
    method: "POST",
    url: "/api/v1/me/notifications/b8000000-0000-4000-8000-000000000002/read",
    headers,
  });
  assert.equal(read.statusCode, 204);
  assert.equal(markedReadBy, user.id);
});

test("account closure requires authentication and uses the verified actor", async (t) => {
  const { server, repository } = await createServer();
  t.after(() => server.close());

  assert.equal((await server.inject({ method: "POST", url: "/api/v1/me/close" })).statusCode, 401);
  const closed = await server.inject({
    method: "POST",
    url: "/api/v1/me/close",
    headers: { authorization: "Bearer valid-token" },
    payload: { userId: "b7000000-0000-4000-8000-000000000001" },
  });
  assert.equal(closed.statusCode, 204);
  assert.equal(repository.accountClosedBy, user.id);
});

test("club closure and ownership transfer use the authenticated actor", async (t) => {
  const { server, repository } = await createServer();
  t.after(() => server.close());
  const headers = { authorization: "Bearer valid-token" };

  const closed = await server.inject({ method: "POST", url: `/api/v1/clubs/${club.id}/close`, headers });
  assert.equal(closed.statusCode, 204);
  assert.equal(repository.clubClosedBy, user.id);

  const newOwnerUserId = "b7000000-0000-4000-8000-000000000001";
  const transferred = await server.inject({
    method: "POST",
    url: `/api/v1/clubs/${club.id}/transfer-ownership`,
    headers,
    payload: { newOwnerUserId },
  });
  assert.equal(transferred.statusCode, 204);
  assert.equal(repository.ownershipTransferredBy, user.id);
  assert.equal(repository.ownershipTarget, newOwnerUserId);
});

test("discovery and membership requests require authentication and use the verified actor", async (t) => {
  const { server, repository } = await createServer();
  t.after(() => server.close());

  assert.equal((await server.inject({ method: "GET", url: "/api/v1/clubs/discovery?q=test" })).statusCode, 401);
  const discovered = await server.inject({
    method: "GET",
    url: "/api/v1/clubs/discovery?q=test",
    headers: { authorization: "Bearer valid-token" },
  });
  assert.equal(discovered.statusCode, 200);
  assert.deepEqual(discovered.json().clubs[0], { id: club.id, name: club.name, visibility: "private", membershipStatus: null });

  const joined = await server.inject({
    method: "POST",
    url: `/api/v1/clubs/${club.id}/membership`,
    headers: { authorization: "Bearer valid-token" },
    payload: { userId: "b7000000-0000-4000-8000-000000000001" },
  });
  assert.equal(joined.statusCode, 201);
  assert.equal(repository.membershipRequestedBy, user.id);
  assert.equal(joined.json().membership.userId, user.id);
});

test("creates a club for the authenticated owner and provisions its first official prices", async (t) => {
  const { repository } = await createServer();
  const drawing: Drawing = {
    id: "b4000000-0000-4000-8000-000000000001",
    lottery: "powerball",
    drawingDate: "2026-11-14",
    state: "MI",
    cutoffTimeEt: "21:58:00",
    status: "pending",
    createdAt: "2026-11-13T00:00:00.000Z",
  };
  let createdInput: CreateClubRequest | null = null;
  repository.createClub = async (userId, input) => {
    assert.equal(userId, user.id);
    createdInput = input;
    return { id: contribution.clubId };
  };
  repository.ensureUpcomingDrawings = async () => [drawing];
  let optionReads = 0;
  repository.getTicketDrawingOptions = async () => {
    optionReads++;
    return [{
      lottery: "powerball",
      drawingDate: drawing.drawingDate,
      maxDrawingCount: 1,
      drawingCountOptions: [1],
      maxNumberSets: 10,
      ticketPrice: optionReads === 1 ? null : 2,
      numberRules: optionReads === 1 ? null : { mainNumberCount: 5, mainNumberMin: 1, mainNumberMax: 69, bonusNumberMin: 1, bonusNumberMax: 26 },
    }];
  };
  const overview = { club: { id: contribution.clubId } } as ClubOverview;
  repository.getClubOverview = async () => overview;
  let prepared = false;
  const server = await buildClubApiServer({
    repository,
    webOrigin: "https://club.example.test",
    verifyToken: async () => ({ subject: user.authSubject!, email: user.email, emailVerified: true, displayName: user.displayName }),
    prepareTicketDrawings: async (userId, clubId, drawings) => {
      assert.equal(userId, user.id);
      assert.equal(clubId, contribution.clubId);
      assert.deepEqual(drawings.map((item) => item.id), [drawing.id]);
      prepared = true;
    },
  });
  t.after(() => server.close());

  const invalid = await server.inject({
    method: "POST",
    url: "/api/v1/clubs",
    headers: { authorization: "Bearer valid-token" },
    payload: { name: "Missing settings" },
  });
  const created = await server.inject({
    method: "POST",
    url: "/api/v1/clubs",
    headers: { authorization: "Bearer valid-token" },
    payload: {
      name: "New club",
      visibility: "private",
      supportedLotteries: ["powerball"],
      payoutConfiguration: { type: "equal_shares" },
      thresholdRule: { thresholdAmount: 100, method: "pooled" },
    },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(created.statusCode, 201);
  assert.equal((createdInput as CreateClubRequest | null)?.name, "New club");
  assert.equal(prepared, true);
  assert.equal(optionReads, 1);
  const readyOptions = await repository.getTicketDrawingOptions(user.id, contribution.clubId);
  assert.equal(readyOptions?.[0].ticketPrice, 2);
  assert.equal(created.json().club.id, contribution.clubId);
});

test("prepares official prices for missing upcoming drawings before returning options", async (t) => {
  const { repository } = await createServer();
  const drawing: Drawing = {
    id: "b4000000-0000-4000-8000-000000000001",
    lottery: "powerball",
    drawingDate: "2026-11-14",
    state: "MI",
    cutoffTimeEt: "21:58:00",
    status: "pending",
    createdAt: "2026-11-13T00:00:00.000Z",
  };
  repository.ensureUpcomingDrawings = async () => [drawing];
  let optionReads = 0;
  repository.getTicketDrawingOptions = async () => {
    optionReads++;
    return [{
      lottery: "powerball",
      drawingDate: drawing.drawingDate,
      maxDrawingCount: 1,
      drawingCountOptions: [1],
      maxNumberSets: 10,
      ticketPrice: optionReads === 1 ? null : 2,
      numberRules: optionReads === 1 ? null : {
        mainNumberCount: 5,
        mainNumberMin: 1,
        mainNumberMax: 69,
        bonusNumberMin: 1,
        bonusNumberMax: 26,
      },
    }];
  };
  let prepared = false;
  const server = await buildClubApiServer({
    repository,
    webOrigin: "https://club.example.test",
    verifyToken: async () => ({ subject: user.authSubject!, email: user.email, emailVerified: true, displayName: user.displayName }),
    prepareTicketDrawings: async (userId, clubId, drawings) => {
      assert.equal(userId, user.id);
      assert.equal(clubId, contribution.clubId);
      assert.deepEqual(drawings.map((item) => item.id), [drawing.id]);
      prepared = true;
    },
  });
  t.after(() => server.close());

  const response = await server.inject({
    method: "GET",
    url: `/api/v1/clubs/${contribution.clubId}/ticket-drawings`,
    headers: { authorization: "Bearer valid-token" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(prepared, true);
  assert.equal(optionReads, 2);
  assert.equal(response.json()[0].ticketPrice, 2);
});

test("ticket drawing options require authentication and use the authenticated user", async (t) => {
  const { server, repository } = await createServer();
  t.after(() => server.close());
  const url = `/api/v1/clubs/${contribution.clubId}/ticket-drawings`;
  assert.equal((await server.inject({ method: "GET", url })).statusCode, 401);
  assert.equal((await server.inject({ method: "GET", url, headers: { authorization: "Bearer valid-token" } })).statusCode, 200);
  repository.getTicketDrawingOptions = async () => null;
  assert.equal((await server.inject({ method: "GET", url, headers: { authorization: "Bearer valid-token" } })).statusCode, 404);
});

test("validates contribution input and associates creation with the authenticated user", async (t) => {
  const { server, repository } = await createServer();
  t.after(() => server.close());
  const headers = { authorization: "Bearer valid-token" };
  const clubId = contribution.clubId;

  const invalid = await server.inject({
    method: "POST",
    url: `/api/v1/clubs/${clubId}/contributions`,
    headers,
    payload: { lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 1, numbers: [1, 1, 3, 4, 5], bonusNumber: 6 },
  });
  const valid = await server.inject({
    method: "POST",
    url: `/api/v1/clubs/${clubId}/contributions`,
    headers,
    payload: { lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 1, numbers: [1, 2, 3, 4, 5], bonusNumber: 6 },
  });
  const invalidPowerballCount = await server.inject({
    method: "POST", url: `/api/v1/clubs/${clubId}/contributions`, headers,
    payload: { lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 2, numbers: [1, 2, 3, 4, 5], bonusNumber: 6 },
  });
  const validMegaCount = await server.inject({
    method: "POST", url: `/api/v1/clubs/${clubId}/contributions`, headers,
    payload: { lottery: "mega_millions", drawingDate: "2026-11-10", drawingCount: 26, numberSets: [{ numbers: [1, 2, 3, 4, 5], bonusNumber: 6, megaplier: 3 }] },
  });
  const invalidMegaCount = await server.inject({
    method: "POST", url: `/api/v1/clubs/${clubId}/contributions`, headers,
    payload: { lottery: "mega_millions", drawingDate: "2026-11-10", drawingCount: 27, numberSets: [{ numbers: [1, 2, 3, 4, 5], bonusNumber: 6, megaplier: 3 }] },
  });
  const tooManyPanels = await server.inject({
    method: "POST", url: `/api/v1/clubs/${clubId}/contributions`, headers,
    payload: { lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 1, numberSets: Array.from({ length: 11 }, (_, index) => ({ numbers: [1, 2, 3, 4, index + 5], bonusNumber: 6 })) },
  });

  assert.equal(invalid.statusCode, 400);
  assert.equal(valid.statusCode, 201);
  assert.equal(invalidPowerballCount.statusCode, 400);
  assert.equal(validMegaCount.statusCode, 201);
  assert.equal(invalidMegaCount.statusCode, 400);
  assert.equal(tooManyPanels.statusCode, 400);
  assert.equal(valid.json().userId, user.id);
  assert.equal(repository.createdBy, user.id);
});

test("validates ticket edits and associates them with the authenticated owner", async (t) => {
  const { server, repository } = await createServer();
  t.after(() => server.close());
  const url = `/api/v1/clubs/${contribution.clubId}/contributions/${contribution.id}`;
  const headers = { authorization: "Bearer valid-token" };
  const payload = { lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 1, numberSets: [{ numbers: [1, 2, 3, 4, 5], bonusNumber: 6 }] };
  assert.equal((await server.inject({ method: "PATCH", url, payload })).statusCode, 401);
  assert.equal((await server.inject({ method: "PATCH", url, headers, payload: { ...payload, drawingCount: 0 } })).statusCode, 400);
  const updated = await server.inject({ method: "PATCH", url, headers, payload });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().contribution.version, 2);
  assert.equal(repository.updatedBy, user.id);
});

test("accepts multiple plays and rejects an invalid play", async (t) => {
  const { server } = await createServer();
  t.after(() => server.close());
  const url = `/api/v1/clubs/${contribution.clubId}/contributions`;
  const headers = { authorization: "Bearer valid-token" };
  const payload = {
    lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 1,
    numberSets: [
      { numbers: [1, 2, 3, 4, 5], bonusNumber: 6 },
      { numbers: [7, 8, 9, 10, 11], bonusNumber: 12 },
    ],
  };
  assert.equal((await server.inject({ method: "POST", url, headers, payload })).statusCode, 201);
  payload.numberSets[1].numbers = [7, 7, 9, 10, 11];
  assert.equal((await server.inject({ method: "POST", url, headers, payload })).statusCode, 400);
  payload.numberSets = Array.from({ length: 11 }, (_, index) => ({ numbers: [1, 2, 3, 4, index + 5], bonusNumber: 6 }));
  assert.equal((await server.inject({ method: "POST", url, headers, payload })).statusCode, 400);
});

test("accepts Powerball add-ons and requires a valid Mega Millions multiplier", async (t) => {
  const { server } = await createServer();
  t.after(() => server.close());
  const url = `/api/v1/clubs/${contribution.clubId}/contributions`;
  const headers = { authorization: "Bearer valid-token" };
  const play = { numbers: [1, 2, 3, 4, 5], bonusNumber: 6 };
  const post = (lottery: string, drawingDate: string, extra: Record<string, unknown>) =>
    server.inject({ method: "POST", url, headers, payload: { lottery, drawingDate, drawingCount: 1, numberSets: [{ ...play, ...extra }] } });

  assert.equal((await post("powerball", "2026-11-09", { powerPlay: true, doublePlay: true })).statusCode, 201);
  assert.equal((await post("powerball", "2026-11-09", { megaplier: 3 })).statusCode, 400);
  assert.equal((await post("mega_millions", "2026-11-10", { megaplier: 10 })).statusCode, 201);
  assert.equal((await post("mega_millions", "2026-11-10", {})).statusCode, 400);
  assert.equal((await post("mega_millions", "2026-11-10", { megaplier: 6 })).statusCode, 400);
  assert.equal((await post("mega_millions", "2026-11-10", { megaplier: 2, powerPlay: true })).statusCode, 400);
});

test("accepts a ticket photo with a contribution and protects photo retrieval", async (t) => {
  const { server, repository } = await createServer();
  t.after(() => server.close());
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  let savedPhoto: { data: Buffer; contentType: string } | undefined;
  repository.createContribution = async (userId, clubId, input, photo) => {
    assert.equal(userId, user.id);
    assert.equal(clubId, contribution.clubId);
    savedPhoto = photo;
    return { ...contribution, ticketImageUrl: "/photo" };
  };
  repository.getContributionPhoto = async (userId, clubId, contributionId) => {
    assert.equal(userId, user.id);
    assert.equal(clubId, contribution.clubId);
    assert.equal(contributionId, contribution.id);
    return savedPhoto ?? null;
  };
  const boundary = "ticket-photo-test";
  const multipart = (data: Buffer) => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="contribution"\r\n\r\n${JSON.stringify({ lottery: "powerball", drawingDate: "2026-11-09", drawingCount: 1, numbers: [1, 2, 3, 4, 5], bonusNumber: 6 })}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="ticket.png"\r\nContent-Type: image/png\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const url = `/api/v1/clubs/${contribution.clubId}/contributions`;
  const headers = { authorization: "Bearer valid-token", "content-type": `multipart/form-data; boundary=${boundary}` };
  const invalid = await server.inject({ method: "POST", url, headers, payload: multipart(Buffer.from("not an image")) });
  assert.equal(invalid.statusCode, 400);
  assert.equal(savedPhoto, undefined);
  const tooLarge = await server.inject({ method: "POST", url, headers, payload: multipart(Buffer.alloc(5 * 1024 * 1024 + 1)) });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(savedPhoto, undefined);
  const created = await server.inject({ method: "POST", url, headers, payload: multipart(image) });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(savedPhoto, { data: image, contentType: "image/png" });
  const photoUrl = `${url}/${contribution.id}/photo`;
  assert.equal((await server.inject({ method: "GET", url: photoUrl })).statusCode, 401);
  const photo = await server.inject({ method: "GET", url: photoUrl, headers: { authorization: "Bearer valid-token" } });
  assert.equal(photo.statusCode, 200);
  assert.equal(photo.headers["content-type"], "image/png");
  assert.deepEqual(photo.rawPayload, image);
  const maximum = Buffer.concat([image, Buffer.alloc(5 * 1024 * 1024 - image.length)]);
  assert.equal((await server.inject({ method: "POST", url, headers, payload: multipart(maximum) })).statusCode, 201);
  repository.getContributionPhoto = async () => null;
  assert.equal((await server.inject({ method: "GET", url: photoUrl, headers: { authorization: "Bearer valid-token" } })).statusCode, 404);
});
