import assert from "node:assert/strict";
import test from "node:test";

import type { Contribution, User } from "../domain";
import type { ClubApiRepository } from "./club-api-server";
import { buildClubApiServer } from "./club-api-server";

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

function createRepository(): ClubApiRepository & { createdBy: string | null } {
  return {
    createdBy: null,
    async provisionOidcUser(identity) {
      assert.equal(identity.emailVerified, true);
      return user;
    },
    async getClubOverview() { return null; },
    async getTicketDrawingOptions(userId) {
      return userId === user.id ? [] : null;
    },
    async getContributionPhoto() { return null; },
    async createContribution(userId) {
      this.createdBy = userId;
      return contribution;
    },
  };
}

async function createServer(repository = createRepository()) {
  const server = await buildClubApiServer({
    repository,
    webOrigin: "https://club.example.test",
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

  assert.equal(invalid.statusCode, 400);
  assert.equal(valid.statusCode, 201);
  assert.equal(valid.json().userId, user.id);
  assert.equal(repository.createdBy, user.id);
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
