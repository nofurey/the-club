import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OidcIdentity {
  subject: string;
  email: string;
  emailVerified: true;
  displayName: string;
}

export class OidcEmailVerificationRequiredError extends Error {
  constructor() {
    super("Verify your email address with your identity provider, then sign out and sign in again.");
  }
}

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  userinfoUrl?: string;
  fetcher?: typeof fetch;
}

export type OidcTokenVerifier = (token: string) => Promise<OidcIdentity>;

export function createOidcTokenVerifier({ issuer, audience, jwksUrl, userinfoUrl, fetcher = fetch }: OidcVerifierOptions): OidcTokenVerifier {
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

  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer,
      audience,
      algorithms: ["RS256", "ES256"],
    });

    const tokenSubject = typeof payload.sub === "string" ? payload.sub : null;
    let email = typeof payload.email === "string" ? payload.email : null;
    let emailVerified = payload.email_verified === true;
    let subject = tokenSubject;
    let displayName = typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : typeof payload.preferred_username === "string" && payload.preferred_username.trim()
        ? payload.preferred_username.trim()
        : email ?? "";

    if ((!subject || !email || !emailVerified) && userinfo) {
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
      if (typeof claims.name === "string" && claims.name.trim()) displayName = claims.name.trim();
      else if (typeof claims.preferred_username === "string" && claims.preferred_username.trim()) {
        displayName = claims.preferred_username.trim();
      }
    }

    if (!emailVerified) {
      throw new OidcEmailVerificationRequiredError();
    }
    if (!subject || !email) {
      throw new Error("OIDC token and UserInfo must identify the user and include a verified email.");
    }

    return {
      subject,
      email: email.trim().toLowerCase(),
      emailVerified: true,
      displayName,
    };
  };
}

function thisRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}