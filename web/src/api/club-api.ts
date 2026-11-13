import { UserManager, WebStorageStateStore, type UserManagerSettings } from "oidc-client-ts";

import type { Contribution } from "../../../src/domain";
import { demoClubApi } from "./demo-club-api";
import type { Club, ClubApi, ClubDiscoverySummary, ClubOverview, CreateClubRequest, CreateContributionInput, MembershipActionResult, MembershipRequestView, Notification, NotificationPreference, TicketDrawingOption, UpdateClubSettingsRequest, UpdateContributionResult, UpdateNotificationPreferencesRequest, User, UserClubSummary } from "./contracts";

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
      try {
        await this.userManager.signinRedirectCallback();
      } catch (error) {
        if (error instanceof Error && /no matching state found in storage/i.test(error.message)) {
          throw new Error("Sign-in state was not found. Start sign-in again from this same tab and app address.");
        }
        throw error;
      } finally {
        window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
      }
    }
    const user = await this.userManager.getUser();
    return Boolean(user && !user.expired && user.access_token);
  }

  async signIn(): Promise<void> {
    await this.userManager.signinRedirect();
  }

  async signUp(): Promise<void> {
    await this.userManager.signinRedirect({ extraQueryParams: { prompt: "login" } });
  }

  async signOut(): Promise<void> {
    await this.userManager.signoutRedirect();
  }

  async closeAccount(): Promise<void> {
    await this.requestResponse("/me/close", { method: "POST" });
  }

  async getCurrentUser(): Promise<User> {
    const response = await this.request<{ user: User }>("/me");
    if (!response.user) throw new Error("The signed-in user could not be loaded.");
    return response.user;
  }

  async getNotifications(): Promise<Notification[]> {
    const response = await this.request<{ notifications: Notification[] }>("/me/notifications");
    return response.notifications;
  }

  async getNotificationPreferences(): Promise<NotificationPreference> {
    const response = await this.request<{ preferences: NotificationPreference }>("/me/notification-preferences");
    return response.preferences;
  }

  async updateNotificationPreferences(input: UpdateNotificationPreferencesRequest): Promise<NotificationPreference> {
    const response = await this.request<{ preferences: NotificationPreference }>("/me/notification-preferences", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return response.preferences;
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.requestResponse(`/me/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST" });
  }

  async getOverview(): Promise<ClubOverview> {
    if (!this.clubId) {
      const clubs = await this.getMyClubs();
      if (!clubs[0]) throw new Error("Join or create a club to continue.");
      this.setActiveClubId(clubs[0].id);
    }
    try {
      return await this.request(`/clubs/${encodeURIComponent(this.clubId)}/overview`);
    } catch (error) {
      if (!(error instanceof ApiResponseError) || error.status !== 404) throw error;
      const clubs = await this.getMyClubs();
      const fallback = clubs.find((item) => item.id !== this.clubId) ?? clubs[0];
      if (!fallback) throw error;
      this.setActiveClubId(fallback.id);
      return this.request(`/clubs/${encodeURIComponent(this.clubId)}/overview`);
    }
  }

  async getMyClubs(): Promise<UserClubSummary[]> {
    const response = await this.request<{ clubs: UserClubSummary[] }>("/me/clubs");
    return response.clubs;
  }

  async searchClubs(query: string): Promise<ClubDiscoverySummary[]> {
    const response = await this.request<{ clubs: ClubDiscoverySummary[] }>(`/clubs/discovery?q=${encodeURIComponent(query)}`);
    return response.clubs;
  }

  async requestMembership(clubId: string): Promise<MembershipActionResult> {
    const response = await this.request<{ membership: MembershipActionResult }>(`/clubs/${encodeURIComponent(clubId)}/membership`, { method: "POST" });
    return response.membership;
  }

  async getMembershipRequests(): Promise<MembershipRequestView[]> {
    const response = await this.request<{ requests: MembershipRequestView[] }>(`/clubs/${encodeURIComponent(this.clubId)}/membership-requests`);
    return response.requests;
  }

  async approveMembership(userId: string): Promise<MembershipActionResult> {
    const response = await this.request<{ membership: MembershipActionResult }>(`/clubs/${encodeURIComponent(this.clubId)}/membership-requests/${encodeURIComponent(userId)}/approve`, { method: "POST" });
    return response.membership;
  }

  async rejectMembership(userId: string): Promise<MembershipActionResult> {
    const response = await this.request<{ membership: MembershipActionResult }>(`/clubs/${encodeURIComponent(this.clubId)}/membership-requests/${encodeURIComponent(userId)}/reject`, { method: "POST" });
    return response.membership;
  }

  async leaveClub(): Promise<MembershipActionResult> {
    const response = await this.request<{ membership: MembershipActionResult }>(`/clubs/${encodeURIComponent(this.clubId)}/leave`, { method: "POST" });
    return response.membership;
  }

  async removeMember(userId: string): Promise<MembershipActionResult> {
    const response = await this.request<{ membership: MembershipActionResult }>(`/clubs/${encodeURIComponent(this.clubId)}/members/${encodeURIComponent(userId)}/remove`, { method: "POST" });
    return response.membership;
  }

  async updateMembershipRole(userId: string, role: "admin" | "member"): Promise<MembershipActionResult> {
    const response = await this.request<{ membership: MembershipActionResult }>(`/clubs/${encodeURIComponent(this.clubId)}/members/${encodeURIComponent(userId)}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
    return response.membership;
  }

  async closeClub(): Promise<void> {
    await this.requestResponse(`/clubs/${encodeURIComponent(this.clubId)}/close`, { method: "POST" });
  }

  async transferOwnership(newOwnerUserId: string): Promise<void> {
    await this.requestResponse(`/clubs/${encodeURIComponent(this.clubId)}/transfer-ownership`, {
      method: "POST",
      body: JSON.stringify({ newOwnerUserId }),
    });
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

  async updateContribution(contributionId: string, input: CreateContributionInput): Promise<UpdateContributionResult> {
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
    throw new Error("Configure the OIDC authority and client ID to enable sign-in.");
  }
  async signUp(): Promise<void> { throw new Error("Configure the OIDC authority and client ID to enable account creation."); }
  async signOut(): Promise<void> { throw new Error("OIDC is not configured."); }
  async closeAccount(): Promise<void> { throw new Error("OIDC is not configured."); }
  async getCurrentUser(): Promise<User> { throw new Error("OIDC is not configured."); }
  async getNotifications(): Promise<Notification[]> { throw new Error("OIDC is not configured."); }
  async getNotificationPreferences(): Promise<NotificationPreference> { throw new Error("OIDC is not configured."); }
  async updateNotificationPreferences(): Promise<NotificationPreference> { throw new Error("OIDC is not configured."); }
  async markNotificationRead(): Promise<void> { throw new Error("OIDC is not configured."); }
  async getOverview(): Promise<ClubOverview> { throw new Error("OIDC is not configured."); }
  async getMyClubs(): Promise<UserClubSummary[]> { throw new Error("OIDC is not configured."); }
  async searchClubs(): Promise<ClubDiscoverySummary[]> { throw new Error("OIDC is not configured."); }
  async requestMembership(): Promise<MembershipActionResult> { throw new Error("OIDC is not configured."); }
  async getMembershipRequests(): Promise<MembershipRequestView[]> { throw new Error("OIDC is not configured."); }
  async approveMembership(): Promise<MembershipActionResult> { throw new Error("OIDC is not configured."); }
  async rejectMembership(): Promise<MembershipActionResult> { throw new Error("OIDC is not configured."); }
  async leaveClub(): Promise<MembershipActionResult> { throw new Error("OIDC is not configured."); }
  async removeMember(): Promise<MembershipActionResult> { throw new Error("OIDC is not configured."); }
  async updateMembershipRole(): Promise<MembershipActionResult> { throw new Error("OIDC is not configured."); }
  async closeClub(): Promise<void> { throw new Error("OIDC is not configured."); }
  async transferOwnership(): Promise<void> { throw new Error("OIDC is not configured."); }
  setActiveClubId(): void { throw new Error("OIDC is not configured."); }
  async createClub(): Promise<ClubOverview> { throw new Error("OIDC is not configured."); }
  async updateClubSettings(): Promise<Club> { throw new Error("OIDC is not configured."); }
  async getTicketDrawingOptions(): Promise<TicketDrawingOption[]> { throw new Error("OIDC is not configured."); }
  async createContribution(): Promise<Contribution> { throw new Error("OIDC is not configured."); }
  async updateContribution(): Promise<UpdateContributionResult> { throw new Error("OIDC is not configured."); }
  async getContributionPhoto(): Promise<Blob> { throw new Error("OIDC is not configured."); }
}

export function createClubApi(): ClubApi {
  if (import.meta.env.VITE_USE_DEMO_API === "true") {
    return demoClubApi;
  }

  const authority = import.meta.env.VITE_OIDC_AUTHORITY?.trim();
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID?.trim();
  const configuredClubId = import.meta.env.VITE_CLUB_ID?.trim();
  let clubId = configuredClubId ?? "";
  try { clubId = window.sessionStorage.getItem("the-club.active-club-id")?.trim() || clubId; } catch {}
  if (!authority || !clientId) {
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