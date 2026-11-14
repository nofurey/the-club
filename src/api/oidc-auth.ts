import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OidcIdentity {
  subject: string;
  email: string;
  emailVerified: true;
  displayName: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export class OidcEmailVerificationRequiredError extends Error {
  constructor() {
    super("Verify your email address with your identity provider, then sign out and sign in again.");
  }
}

export class OidcProfileIncompleteError extends Error {
  constructor() {
    super("Your identity provider must supply a username, first name, and last name.");
  }
}

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  cognitoClientId?: string;
  requireCognitoProfile?: boolean;
  jwksUrl: string;
  userinfoUrl?: string;
  fetcher?: typeof fetch;
}

export type OidcTokenVerifier = (token: string, identityToken?: string) => Promise<OidcIdentity>;

export function createOidcTokenVerifier({ issuer, audience, cognitoClientId, requireCognitoProfile = false, jwksUrl, userinfoUrl, fetcher = fetch }: OidcVerifierOptions): OidcTokenVerifier {
  const issuerUrl = new URL(issuer);
  const jwks = new URL(jwksUrl);
  const isLoopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const userinfo = userinfoUrl ? new URL(userinfoUrl) : null;
  if (
    (issuerUrl.protocol !== "https:" && !isLoopback(issuerUrl)) ||
    (jwks.protocol !== "https:" && !isLoopback(jwks)) ||
    (userinfo && userinfo.protocol !== "https:" && !isLoopback(userinfo))
  ) {
    throw new Error("OIDC issuer, JWKS, and UserInfo URLs must use HTTPS outside localhost development.");
  }
  const keySet = createRemoteJWKSet(jwks);

  return async (token, identityToken) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      algorithms: ["RS256", "ES256"],
    });
    const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const audienceMatches = tokenAudiences.includes(audience);
    const cognitoClaimsMatch = Boolean(cognitoClientId) && payload.token_use === "access" &&
      payload.client_id === cognitoClientId && (payload.aud === undefined || audienceMatches);
    if (cognitoClientId ? !cognitoClaimsMatch : !audienceMatches || payload.token_use === "id") {
      throw new Error("OIDC token audience is not authorized.");
    }

    const tokenSubject = typeof payload.sub === "string" ? payload.sub : null;
    let email = typeof payload.email === "string" ? payload.email : null;
    let emailVerified = payload.email_verified === true;
    let subject = tokenSubject;
    let username = typeof payload.preferred_username === "string" && payload.preferred_username.trim()
      ? payload.preferred_username.trim()
      : null;
    let firstName = typeof payload.given_name === "string" && payload.given_name.trim()
      ? payload.given_name.trim()
      : null;
    let lastName = typeof payload.family_name === "string" && payload.family_name.trim()
      ? payload.family_name.trim()
      : null;
    let displayName = `${firstName ?? ""} ${lastName ?? ""}`.trim() ||
      (typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : typeof payload.preferred_username === "string" && payload.preferred_username.trim()
        ? payload.preferred_username.trim()
        : email ?? "");

    if ((!subject || !email || !emailVerified || (cognitoClientId && requireCognitoProfile && (!username || !firstName || !lastName))) && userinfo) {
      const response = await fetcher(userinfo.href, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`OIDC UserInfo request failed with HTTP ${response.status}.`);
      }
      const claims: unknown = await response.json();
      if (!thisRecord(claims) || typeof claims.sub !== "string") {
        throw new Error("OIDC UserInfo response must include a subject.");
      }
      if (tokenSubject && claims.sub !== tokenSubject) {
        throw new Error("OIDC UserInfo subject did not match the access token.");
      }
      subject = typeof claims.sub === "string" ? claims.sub : null;
      if (typeof claims.email === "string") email = claims.email;
      emailVerified = claims.email_verified === true;
      if (typeof claims.preferred_username === "string" && claims.preferred_username.trim()) username = claims.preferred_username.trim();
      if (typeof claims.given_name === "string" && claims.given_name.trim()) firstName = claims.given_name.trim();
      if (typeof claims.family_name === "string" && claims.family_name.trim()) lastName = claims.family_name.trim();
      displayName = `${firstName ?? ""} ${lastName ?? ""}`.trim() ||
        (typeof claims.name === "string" && claims.name.trim()
          ? claims.name.trim()
          : username ?? email ?? "");
    }

    if ((!emailVerified || (requireCognitoProfile && (!username || !firstName || !lastName))) && cognitoClientId && identityToken) {
      const { payload: identityPayload } = await jwtVerify(identityToken, keySet, {
        issuer,
        audience: cognitoClientId,
        algorithms: ["RS256", "ES256"],
      });
      if (
        identityPayload.token_use !== "id" ||
        typeof identityPayload.sub !== "string" ||
        (tokenSubject && identityPayload.sub !== tokenSubject)
      ) {
        throw new Error("Cognito identity token does not match the access token.");
      }
      if (identityPayload.email_verified === true) {
        const identityEmail = typeof identityPayload.email === "string" ? identityPayload.email : null;
        if (email && identityEmail && email.toLowerCase() !== identityEmail.toLowerCase()) {
          throw new Error("Cognito identity token email does not match the access token.");
        }
        subject = identityPayload.sub;
        email = identityEmail ?? email;
        emailVerified = true;
        if (typeof identityPayload.preferred_username === "string" && identityPayload.preferred_username.trim()) username = identityPayload.preferred_username.trim();
        if (typeof identityPayload.given_name === "string" && identityPayload.given_name.trim()) firstName = identityPayload.given_name.trim();
        if (typeof identityPayload.family_name === "string" && identityPayload.family_name.trim()) lastName = identityPayload.family_name.trim();
        displayName = `${firstName ?? ""} ${lastName ?? ""}`.trim() ||
          (typeof identityPayload.name === "string" && identityPayload.name.trim()
            ? identityPayload.name.trim()
            : username ?? email ?? "");
      }
    }

    if (!emailVerified) {
      throw new OidcEmailVerificationRequiredError();
    }
    if (!subject || !email) {
      throw new Error("OIDC token and UserInfo must identify the user and include a verified email.");
    }
    if (cognitoClientId && requireCognitoProfile && (!username || !firstName || !lastName)) {
      throw new OidcProfileIncompleteError();
    }

    return {
      subject,
      email: email.trim().toLowerCase(),
      emailVerified: true,
      displayName,
      ...(username ? { username } : {}),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
    };
  };
}

function thisRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}