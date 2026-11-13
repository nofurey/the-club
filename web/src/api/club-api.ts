import { UserManager, WebStorageStateStore, type UserManagerSettings } from "oidc-client-ts";

import type { Contribution } from "../../../src/domain";
import { demoClubApi } from "./demo-club-api";
import type { Club, ClubApi, ClubOverview, CreateClubRequest, CreateContributionInput, TicketDrawingOption, UpdateClubSettingsRequest, UserClubSummary } from "./contracts";

class ApiResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

class OidcHttpClubApi implements ClubApi {
  readonly mode = "oidc" as const;
  private readonly userManager: UserManager;
  private initialization?: Promise<boolean>;

  constructor(
    private readonly apiBaseUrl: string,
    private clubId: string,
    settings: UserManagerSettings
  ) {
    this.userManager = new UserManager(settings);
  }

  initialize(): Promise<boolean> {
    return this.initialization ??= this.initializeOnce();
  }

  private async initializeOnce(): Promise<boolean> {
    if (new URLSearchParams(window.location.search).has("code")) {
      await this.userManager.signinRedirectCallback();
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    }
    const user = await this.userManager.getUser();
    return Boolean(user && !user.expired && user.access_token);
  }

  async signIn(): Promise<void> {
    await this.userManager.signinRedirect();
  }

  async getOverview(): Promise<ClubOverview> {
    return this.request(`/clubs/${encodeURIComponent(this.clubId)}/overview`);
  }

  async getMyClubs(): Promise<UserClubSummary[]> {
    const response = await this.request<{ clubs: UserClubSummary[] }>("/me/clubs");
    return response.clubs;
  }

  setActiveClubId(clubId: string): void {
    this.clubId = clubId;
    try { window.sessionStorage.setItem("the-club.active-club-id", clubId); } catch {}
  }

  async createClub(input: CreateClubRequest): Promise<ClubOverview> {
    const overview = await this.request<ClubOverview>("/clubs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    this.setActiveClubId(overview.club.id);
    return overview;
  }

  async updateClubSettings(input: UpdateClubSettingsRequest): Promise<Club> {
    const response = await this.request<{ club: Club }>(`/clubs/${encodeURIComponent(this.clubId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return response.club;
  }

  async getTicketDrawingOptions(): Promise<TicketDrawingOption[]> {
    return this.request(`/clubs/${encodeURIComponent(this.clubId)}/ticket-drawings`);
  }

  async createContribution(input: CreateContributionInput, photo?: File): Promise<Contribution> {
    let body: BodyInit = JSON.stringify(input);
    if (photo) {
      const form = new FormData();
      form.append("contribution", JSON.stringify(input));
      form.append("photo", photo);
      body = form;
    }
    return this.request(`/clubs/${encodeURIComponent(this.clubId)}/contributions`, {
      method: "POST",
      body,
    });
  }

  async updateContribution(contributionId: string, input: CreateContributionInput): Promise<Contribution> {
    return this.request(`/clubs/${encodeURIComponent(this.clubId)}/contributions/${encodeURIComponent(contributionId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async getContributionPhoto(contributionId: string): Promise<Blob> {
    const response = await this.requestResponse(`/clubs/${encodeURIComponent(this.clubId)}/contributions/${encodeURIComponent(contributionId)}/photo`);
    return response.blob();
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.requestResponse(path, init);
    return response.json() as Promise<T>;
  }

  private async requestResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const user = await this.userManager.getUser();
    if (!user || user.expired || !user.access_token) {
      throw new ApiResponseError("Your sign-in has expired. Sign in again to continue.", 401);
    }
    const response = await fetch(`${this.apiBaseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
        Authorization: `Bearer ${user.access_token}`,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string } | null;
      throw new ApiResponseError(body?.message ?? `The API request failed (${response.status}).`, response.status);
    }
    return response;
  }
}

class UnconfiguredClubApi implements ClubApi {
  readonly mode = "unconfigured" as const;

  async initialize(): Promise<boolean> { return false; }
  async signIn(): Promise<void> {
    throw new Error("Configure the OIDC authority, client ID, and club ID to enable sign-in.");
  }
  async getOverview(): Promise<ClubOverview> { throw new Error("OIDC is not configured."); }
  async getMyClubs(): Promise<UserClubSummary[]> { throw new Error("OIDC is not configured."); }
  setActiveClubId(): void { throw new Error("OIDC is not configured."); }
  async createClub(): Promise<ClubOverview> { throw new Error("OIDC is not configured."); }
  async updateClubSettings(): Promise<Club> { throw new Error("OIDC is not configured."); }
  async getTicketDrawingOptions(): Promise<TicketDrawingOption[]> { throw new Error("OIDC is not configured."); }
  async createContribution(): Promise<Contribution> { throw new Error("OIDC is not configured."); }
  async updateContribution(): Promise<Contribution> { throw new Error("OIDC is not configured."); }
  async getContributionPhoto(): Promise<Blob> { throw new Error("OIDC is not configured."); }
}

export function createClubApi(): ClubApi {
  if (import.meta.env.VITE_USE_DEMO_API === "true") {
    return demoClubApi;
  }

  const authority = import.meta.env.VITE_OIDC_AUTHORITY?.trim();
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID?.trim();
  const configuredClubId = import.meta.env.VITE_CLUB_ID?.trim();
  let clubId = configuredClubId;
  try { clubId = window.sessionStorage.getItem("the-club.active-club-id")?.trim() || configuredClubId; } catch {}
  if (!authority || !clientId || !clubId) {
    return new UnconfiguredClubApi();
  }

  const settings: UserManagerSettings = {
    authority,
    client_id: clientId,
    redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI?.trim() || `${window.location.origin}/`,
    post_logout_redirect_uri: import.meta.env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI?.trim() || `${window.location.origin}/`,
    response_type: "code",
    scope: import.meta.env.VITE_OIDC_SCOPE?.trim() || "openid profile email",
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  };

  return new OidcHttpClubApi(import.meta.env.VITE_API_BASE_URL?.trim() || "/api/v1", clubId, settings);
}