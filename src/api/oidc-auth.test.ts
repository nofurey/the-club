import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { createOidcTokenVerifier } from "./oidc-auth";

const issuer = "https://identity.example.test/";
const audience = "the-club-api";

test("verifies OIDC signatures, issuer, audience, and verified-email claims", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const jwk = { ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" };
  const jwksServer = createServer((request, response) => {
    if (request.url !== "/jwks") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve())));
  const address = jwksServer.address();
  assert.ok(address && typeof address !== "string");

  const jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
  const verify = createOidcTokenVerifier({ issuer, audience, jwksUrl });
  const verifyCognito = createOidcTokenVerifier({ issuer, audience, cognitoClientId: "cognito-client-123", jwksUrl });
  const verifyCognitoProfile = createOidcTokenVerifier({
    issuer,
    audience,
    cognitoClientId: "cognito-client-123",
    requireCognitoProfile: true,
    jwksUrl,
  });
  const validToken = await new SignJWT({
    email: "member@example.test",
    email_verified: true,
    name: "Verified Member",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("subject-123")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);

  assert.deepEqual(await verify(validToken), {
    subject: "subject-123",
    email: "member@example.test",
    emailVerified: true,
    displayName: "Verified Member",
  });

  const cognitoAccessToken = await new SignJWT({
    client_id: "cognito-client-123",
    token_use: "access",
    email: "member@example.test",
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("cognito-subject")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  assert.equal((await verifyCognito(cognitoAccessToken)).subject, "cognito-subject");
  await assert.rejects(() => verifyCognitoProfile(cognitoAccessToken), /username, first name, and last name/i);

  const completeCognitoToken = await new SignJWT({
    client_id: "cognito-client-123",
    token_use: "access",
    email: "member@example.test",
    email_verified: true,
    preferred_username: "member.handle",
    given_name: "First",
    family_name: "Last",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("cognito-subject")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  assert.deepEqual(await verifyCognitoProfile(completeCognitoToken), {
    subject: "cognito-subject",
    email: "member@example.test",
    emailVerified: true,
    displayName: "First Last",
    username: "member.handle",
    firstName: "First",
    lastName: "Last",
  });

  const unverifiedAccessToken = await new SignJWT({
    client_id: "cognito-client-123",
    token_use: "access",
    email: "member@example.test",
    email_verified: false,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("cognito-subject")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  const verifiedIdentityToken = await new SignJWT({
    token_use: "id",
    email: "member@example.test",
    email_verified: true,
    preferred_username: "member.handle",
    given_name: "First",
    family_name: "Last",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("cognito-subject")
    .setAudience("cognito-client-123")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  assert.equal((await verifyCognito(unverifiedAccessToken, verifiedIdentityToken)).emailVerified, true);
  assert.deepEqual(await verifyCognitoProfile(unverifiedAccessToken, verifiedIdentityToken), {
    subject: "cognito-subject",
    email: "member@example.test",
    emailVerified: true,
    displayName: "First Last",
    username: "member.handle",
    firstName: "First",
    lastName: "Last",
  });

  const mismatchedIdentityToken = await new SignJWT({
    token_use: "id",
    email: "member@example.test",
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("another-cognito-subject")
    .setAudience("cognito-client-123")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  await assert.rejects(
    () => verifyCognito(unverifiedAccessToken, mismatchedIdentityToken),
    /identity token does not match/i
  );

  const unboundCognitoAccessToken = await new SignJWT({
    aud: "https://another-api.example.test",
    client_id: "cognito-client-123",
    token_use: "access",
    email: "member@example.test",
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("cognito-subject")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  await assert.rejects(() => verifyCognito(unboundCognitoAccessToken), /audience is not authorized/i);

  const unapprovedCognitoAccessToken = await new SignJWT({
    client_id: "another-cognito-client",
    token_use: "access",
    email: "member@example.test",
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("cognito-subject")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  await assert.rejects(() => verifyCognito(unapprovedCognitoAccessToken), /audience is not authorized/i);

  const cognitoIdToken = await new SignJWT({
    client_id: "cognito-client-123",
    token_use: "id",
    email: "member@example.test",
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("cognito-subject")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  await assert.rejects(() => verifyCognito(cognitoIdToken), /audience is not authorized/i);

  const wrongAudience = await new SignJWT({ email: "member@example.test", email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("subject-123")
    .setAudience("another-api")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  await assert.rejects(() => verify(wrongAudience));

  const unverifiedEmail = await new SignJWT({ email: "member@example.test", email_verified: false })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject("subject-123")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  await assert.rejects(() => verify(unverifiedEmail), /verify your email/i);
});

test("requires HTTPS for non-loopback OIDC issuer and JWKS URLs", () => {
  assert.throws(
    () => createOidcTokenVerifier({ issuer: "http://identity.example.test", audience, jwksUrl: "https://identity.example.test/jwks" }),
    /must use HTTPS/i
  );
  assert.throws(
    () => createOidcTokenVerifier({ issuer, audience, jwksUrl: "http://identity.example.test/jwks" }),
    /must use HTTPS/i
  );
});

test("uses OIDC UserInfo for subject and verified email when access-token claims are missing", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "userinfo-test-key", alg: "RS256", use: "sig" };
  let userInfoSubject = "userinfo-subject";
  const server = createServer((request, response) => {
    if (request.url === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (request.url === "/userinfo") {
      assert.match(request.headers.authorization ?? "", /^Bearer /);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        sub: userInfoSubject,
        email: "member@example.test",
        email_verified: true,
        name: "Verified Member",
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const verify = createOidcTokenVerifier({
    issuer,
    audience,
    jwksUrl: `${baseUrl}/jwks`,
    userinfoUrl: `${baseUrl}/userinfo`,
  });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "userinfo-test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);

  assert.deepEqual(await verify(token), {
    subject: "userinfo-subject",
    email: "member@example.test",
    emailVerified: true,
    displayName: "Verified Member",
  });

  const mismatchedSubjectToken = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "userinfo-test-key" })
    .setIssuer(issuer)
    .setSubject("token-subject")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  userInfoSubject = "different-subject";
  await assert.rejects(() => verify(mismatchedSubjectToken), /subject did not match/i);
});
