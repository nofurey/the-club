import { Fragment, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Eye,
  Image as ImageIcon,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  Pencil,
  Plus,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  Ticket,
  Trophy,
  Trash2,
  Users,
  X,
} from "lucide-react";

import type { Club, Contribution, LotteryType, User } from "../../src/domain";
import { drawingResultState } from "../../src/api/drawing-result-state";
import { emptyOcrModel, findPhotoExample, hasLearnableOcrRows, learnOcrCorrections, parseWithOcrModel, rememberPhotoExample } from "../../src/services/ticket-ocr-learning";
import { clearOcrModel, loadOcrModel, saveOcrModel } from "../../src/services/ticket-ocr-learning-store";
import { createClubApi } from "./api/club-api";
import { demoClubApi } from "./api/demo-club-api";
import type { ClubApi, ClubDiscoverySummary, ClubMemberView, ClubOverview, CreateClubRequest, CreateContributionInput, DrawingResultView, MembershipActionResult, MembershipRequestView, TicketDrawingOption, UpdateClubSettingsRequest, UserClubSummary } from "./api/contracts";
import type { TicketNumberSetInput } from "../../src/api/contracts";

type View = "overview" | "contributions" | "results" | "members" | "discovery";

const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "contributions", label: "Contributions", icon: Ticket },
  { id: "results", label: "Drawing results", icon: Trophy },
  { id: "members", label: "Members", icon: Users },
  { id: "discovery", label: "Discover clubs", icon: Search },
];

const money = (amount: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
}).format(amount);

const compactMoney = (amount: number) => {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
  return money(amount);
};

const ticketMoney = (amount: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
}).format(amount);

const formatDate = (date: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  new Intl.DateTimeFormat("en-US", options).format(new Date(`${date}T12:00:00`));

const lotteryName = (lottery: LotteryType) => lottery === "powerball" ? "Powerball" : "Mega Millions";
const bonusName = (lottery: LotteryType) => lottery === "powerball" ? "Powerball" : "Mega Ball";
const userInitials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "ME";

function readerStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

async function photoFingerprint(photo: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await photo.arrayBuffer());
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function App() {
  const [api, setApi] = useState<ClubApi>(() => createClubApi());
  const [view, setView] = useState<View>("overview");
  const [overview, setOverview] = useState<ClubOverview | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [clubs, setClubs] = useState<UserClubSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingContribution, setEditingContribution] = useState<Contribution | null>(null);
  const [createClubOpen, setCreateClubOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountClosed, setAccountClosed] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    api.initialize()
      .then(async (isAuthenticated) => {
        if (!mounted) return;
        setAuthenticated(isAuthenticated);
        if (!isAuthenticated) return;
        const [user, userClubs] = await Promise.all([api.getCurrentUser(), api.getMyClubs()]);
        const data = userClubs.length ? await api.getOverview() : null;
        if (mounted) {
          setCurrentUser(user);
          setOverview(data);
          setClubs(userClubs);
          if (!data) setView("discovery");
        }
      })
      .catch((cause: unknown) => {
        if (mounted) {
          const message = cause instanceof Error ? cause.message : "Club data could not be loaded.";
          setError(message);
          setAuthMessage(message);
        }
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [api]);

  const addContribution = async (input: CreateContributionInput, photo?: File) => {
    await api.createContribution(input, photo);
    const updated = await api.getOverview();
    setOverview(updated);
    setView("contributions");
    setDialogOpen(false);
    setNotice(api.mode === "demo" ? "Contribution added to the demo club." : "Contribution recorded.");
    window.setTimeout(() => setNotice(null), 3600);
  };

  const openNewContribution = () => {
    setEditingContribution(null);
    setDialogOpen(true);
  };

  const editContribution = (contribution: Contribution) => {
    setEditingContribution(contribution);
    setDialogOpen(true);
  };

  const saveContribution = async (input: CreateContributionInput, photo?: File) => {
    if (!editingContribution) {
      await addContribution(input, photo);
      return;
    }
    const result = await api.updateContribution(editingContribution.id, input);
    const updated = await api.getOverview();
    setOverview(updated);
    setView("contributions");
    setDialogOpen(false);
    setEditingContribution(null);
    setNotice(result.recalculationPending
      ? "Ticket updated and audited. Affected results are pending recalculation."
      : result.recalculatedDrawingCount > 0
        ? `Ticket updated and audited. ${result.recalculatedDrawingCount} drawing results recalculated.`
        : "Ticket updated and audited.");
    window.setTimeout(() => setNotice(null), 3600);
  };

  const createClub = async (input: CreateClubRequest) => {
    const created = await api.createClub(input);
    setOverview(created);
    setCurrentUser(created.currentUser);
    setClubs(await api.getMyClubs());
    setView("overview");
    setCreateClubOpen(false);
    setSwitcherOpen(false);
    setNotice("Club created. Official ticket options are being prepared.");
    window.setTimeout(() => setNotice(null), 4200);
  };

  const switchClub = async (clubId: string) => {
    if (clubId === overview?.club.id) { setSwitcherOpen(false); return; }
    api.setActiveClubId(clubId);
    setSwitcherOpen(false);
    setLoading(true);
    setError(null);
    try {
      const [nextOverview, userClubs] = await Promise.all([api.getOverview(), api.getMyClubs()]);
      setOverview(nextOverview);
      setCurrentUser(nextOverview.currentUser);
      setClubs(userClubs);
      setView("overview");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The selected club could not be opened.");
    } finally {
      setLoading(false);
    }
  };

  const saveClubSettings = async (input: UpdateClubSettingsRequest) => {
    await api.updateClubSettings(input);
    const [updated, userClubs] = await Promise.all([api.getOverview(), api.getMyClubs()]);
    setOverview(updated);
    setClubs(userClubs);
    setSettingsOpen(false);
    setNotice("Club settings saved.");
    window.setTimeout(() => setNotice(null), 3600);
  };

  const refreshMembershipState = async () => {
    const userClubs = await api.getMyClubs();
    setClubs(userClubs);
    if (userClubs.some((item) => item.id === overview?.club.id)) {
      const nextOverview = await api.getOverview();
      setOverview(nextOverview);
      setCurrentUser(nextOverview.currentUser);
      return;
    }
    if (userClubs[0]) {
      api.setActiveClubId(userClubs[0].id);
      const nextOverview = await api.getOverview();
      setOverview(nextOverview);
      setCurrentUser(nextOverview.currentUser);
      setView("overview");
      return;
    }
    setOverview(null);
    setView("discovery");
  };

  const performMembershipAction = async (action: () => Promise<unknown>, message: string) => {
    await action();
    await refreshMembershipState();
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3600);
  };

  const openDiscoveredClub = async (clubId: string): Promise<MembershipActionResult> => {
    const membership = await api.requestMembership(clubId);
    if (membership.status === "active") {
      api.setActiveClubId(clubId);
      const [nextOverview, userClubs] = await Promise.all([api.getOverview(), api.getMyClubs()]);
      setOverview(nextOverview);
      setCurrentUser(nextOverview.currentUser);
      setClubs(userClubs);
      setView("overview");
      setNotice("Club opened.");
    } else {
      setNotice("Request sent for approval.");
    }
    window.setTimeout(() => setNotice(null), 3600);
    return membership;
  };

  const signOut = async () => {
    await api.signOut();
    setAccountOpen(false);
    setError(null);
    setAuthMessage(null);
    setAuthenticated(false);
    setOverview(null);
    setClubs([]);
    setCurrentUser(null);
  };

  const closeAccount = async () => {
    await api.closeAccount();
    await api.signOut().catch(() => undefined);
    setAccountOpen(false);
    setAuthenticated(false);
    setOverview(null);
    setClubs([]);
    setCurrentUser(null);
    setAccountClosed(true);
  };

  const signIn = async () => {
    try {
      setAuthMessage(null);
      await api.signIn();
    } catch (cause) {
      setAuthMessage(cause instanceof Error ? cause.message : "Sign-in could not be started.");
    }
  };

  const signUp = async () => {
    try {
      setAuthMessage(null);
      await api.signUp();
    } catch (cause) {
      setAuthMessage(cause instanceof Error ? cause.message : "Account creation could not be started.");
    }
  };

  const navigate = (nextView: View) => {
    setView(nextView);
    setMobileNavOpen(false);
  };

  if (loading) {
    return <div className="loading-screen"><div className="brand-mark">L</div><span>Opening your club</span></div>;
  }
  if (accountClosed) return <main className="account-closed-screen"><span className="wordmark-stamp">L</span><div className="eyebrow"><span className="eyebrow-line" />ACCOUNT</div><h1>Account closed.</h1><p>Your account is closed and you are signed out. Existing club records remain available to their members.</p></main>;
  if (!authenticated) {
    return <SignInScreen
      configured={api.mode === "oidc"}
      showDemoPreview={import.meta.env.DEV && api.mode === "unconfigured"}
      error={authMessage}
      onSignIn={signIn}
      onSignUp={signUp}
      onDemoPreview={() => { setError(null); setOverview(null); setApi(demoClubApi); }}
    />;
  }
  if (error) {
    return <div className="error-screen"><h1>We couldn't load the club.</h1><p>{error ?? "Try reloading the page."}</p><div className="error-actions"><button className="button button-secondary" onClick={() => void signOut()}>Sign out and retry</button><button className="button button-primary" onClick={() => window.location.reload()}>Reload</button></div></div>;
  }
  if (!overview) return <main className="no-club-screen"><header className="no-club-header"><a className="wordmark" href="#discovery"><span className="wordmark-stamp">L</span><span className="wordmark-name">the club<span className="wordmark-period">.</span></span></a><div className="no-club-actions"><span className="demo-chip"><span className="demo-dot" />SECURE SESSION</span>{currentUser && <button className="button button-secondary" type="button" onClick={() => setAccountOpen(true)}>Account</button>}<button className="button button-primary" type="button" onClick={() => setCreateClubOpen(true)}>Create a club</button></div></header><section className="no-club-content"><div className="eyebrow"><span className="eyebrow-line" />CLUBS / DISCOVER</div><h1>Find your pool.</h1><DiscoveryView api={api} onOpenClub={openDiscoveredClub} /></section>{createClubOpen && <CreateClubDialog onClose={() => setCreateClubOpen(false)} onSubmit={createClub} />}{accountOpen && currentUser && <AccountDialog user={currentUser} onClose={() => setAccountOpen(false)} onSignOut={signOut} onCloseAccount={closeAccount} />}</main>;

  const pageTitles: Record<View, { eyebrow: string; title: string; description: string }> = {
    overview: { eyebrow: "YOUR CLUB / OVERVIEW", title: "The good numbers.", description: "A clear look at the tickets, people, and drawings you share." },
    contributions: { eyebrow: "YOUR CLUB / CONTRIBUTIONS", title: "Tickets on the table.", description: "Every entry your members have shared with the club." },
    results: { eyebrow: "YOUR CLUB / DRAWING RESULTS", title: "The latest draw.", description: "Official numbers and club results, with estimates clearly marked." },
    members: { eyebrow: "YOUR CLUB / MEMBERS", title: "The people in your pool.", description: "Membership, roles, and each member's recorded contribution." },
    discovery: { eyebrow: "CLUBS / DISCOVERY", title: "Find your pool.", description: "Search public clubs or request access to a searchable private club." },
  };
  const page = pageTitles[view];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <a className="wordmark" href="#overview" onClick={(event) => { event.preventDefault(); navigate("overview"); }}>
            <span className="wordmark-stamp">L</span>
            <span className="wordmark-name">the club<span className="wordmark-period">.</span></span>
          </a>
          <button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><X size={18} /></button>
          <div className="club-switcher-wrap">
            <button className="club-switcher" type="button" aria-expanded={switcherOpen} aria-haspopup="menu" onClick={() => setSwitcherOpen((open) => !open)}>
              <span className="club-avatar">{overview.club.name.slice(0, 2).toUpperCase()}</span>
              <span className="club-switcher-copy"><strong>{overview.club.name}</strong><small>{overview.club.visibility === "private" ? "Private club" : "Public club"}</small></span>
              <ChevronDown size={16} />
            </button>
            {switcherOpen && <div className="club-menu" role="menu" aria-label="Your clubs">{clubs.map((item) => <button type="button" role="menuitem" key={item.id} className={item.id === overview.club.id ? "club-menu-item club-menu-item-active" : "club-menu-item"} onClick={() => void switchClub(item.id)}><span><strong>{item.name}</strong><small>{item.role} · {item.visibility}</small></span>{item.id === overview.club.id && <Check size={15} />}</button>)}{!clubs.length && <span className="club-menu-empty">No active clubs</span>}</div>}
          </div>
          <div className="nav-caption">WORKSPACE</div>
          <nav className="primary-nav" aria-label="Club navigation">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button key={id} className={`nav-item ${view === id ? "nav-item-active" : ""}`} onClick={() => navigate(id)}>
                <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
                {id === "contributions" && <span className="nav-count">{overview.contributions.length}</span>}
              </button>
            ))}
          </nav>
          <div className="nav-caption nav-caption-spaced">CLUB</div>
          {api.mode === "oidc" && <button className="nav-item" onClick={() => setCreateClubOpen(true)}>
            <Plus size={18} strokeWidth={1.8} /><span>Create a club</span>
          </button>}
          <button className="nav-item" onClick={() => {
            const role = clubs.find((item) => item.id === overview.club.id)?.role;
            if (role === "creator" || role === "admin") setSettingsOpen(true);
            else setNotice("Only club creators and admins can update club settings.");
          }}>
            <Settings2 size={18} strokeWidth={1.8} /><span>Club settings</span>
          </button>
          <button className="nav-item" onClick={() => setNotice("Help and support will be connected in a later step.")}>
            <CircleHelp size={18} strokeWidth={1.8} /><span>Help & support</span>
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="demo-chip"><span className="demo-dot" />{api.mode === "demo" ? "DEMO DATA" : "SECURE SESSION"}</div>
          <button className="profile-row" type="button" aria-haspopup="dialog" onClick={() => setAccountOpen(true)}>
            <span className="profile-avatar">{userInitials(overview.currentUser.displayName)}</span>
            <span className="profile-copy"><strong>{overview.currentUser.displayName}</strong><small>{overview.members.find((member) => member.userId === overview.currentUser.id)?.role ?? "member"}</small></span>
            <ChevronDown size={15} />
          </button>
        </div>
      </aside>

      {mobileNavOpen && <button className="nav-scrim" aria-label="Close menu" onClick={() => setMobileNavOpen(false)} />}

      <div className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={20} /></button>
          <div className="breadcrumbs"><span>Clubs</span><ChevronRight size={14} /><strong>{overview.club.name}</strong></div>
          <div className="topbar-actions">
            <span className="topbar-date"><CalendarDays size={15} />Monday, November 9</span>
            <button className="icon-button topbar-search" aria-label="Search" onClick={() => setNotice("Search will be connected to the API in a later step.")}><Search size={17} /></button>
            <button className="icon-button notification-button" aria-label="Notifications" onClick={() => setNotice("You're all caught up.")}><Bell size={17} /><span className="notification-dot" /></button>
            <span className="topbar-avatar">{userInitials(overview.currentUser.displayName)}</span>
          </div>
        </header>

        <main className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" />{page.eyebrow}</div>
              <h1>{page.title}</h1>
              <p>{page.description}</p>
            </div>
            <button className="button button-primary add-button" onClick={openNewContribution}><Plus size={17} />Add contribution</button>
          </div>

          {view === "overview" && <OverviewView data={overview} onNavigate={navigate} />}
          {view === "contributions" && <ContributionsView api={api} currentUserId={overview.currentUser.id} contributions={overview.contributions} members={overview.members} onAdd={openNewContribution} onEdit={editContribution} />}
          {view === "results" && <ResultsView results={overview.results} />}
          {view === "members" && <MembersView data={overview} api={api} onAction={performMembershipAction} />}
          {view === "discovery" && <DiscoveryView api={api} onOpenClub={openDiscoveredClub} />}

          <footer className="page-footer">
            <span><ShieldCheck size={14} /> For records only. No money is handled by the app.</span>
            <span>Last synced just now <span className="sync-dot" /></span>
          </footer>
        </main>
      </div>

      {notice && <div className="toast" role="status"><Check size={16} />{notice}<button className="toast-close" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={14} /></button></div>}
      {createClubOpen && <CreateClubDialog onClose={() => setCreateClubOpen(false)} onSubmit={createClub} />}
      {settingsOpen && <ClubSettingsDialog
        club={overview.club}
        members={overview.members}
        currentUserId={overview.currentUser.id}
        canManageOwnership={api.mode === "oidc"}
        onClose={() => setSettingsOpen(false)}
        onSubmit={saveClubSettings}
        onTransferOwnership={async (userId) => { await performMembershipAction(() => api.transferOwnership(userId), "Club ownership transferred."); setSettingsOpen(false); }}
        onCloseClub={async () => { await performMembershipAction(() => api.closeClub(), "Club closed."); setSettingsOpen(false); }}
      />}
      {accountOpen && <AccountDialog user={overview.currentUser} onClose={() => setAccountOpen(false)} onSignOut={signOut} onCloseAccount={closeAccount} />}
      {dialogOpen && <ContributionDialog key={editingContribution?.id ?? "new-contribution"} api={api} userId={overview.currentUser.id} editingContribution={editingContribution ?? undefined} onClose={() => { setDialogOpen(false); setEditingContribution(null); }} onSubmit={saveContribution} onLearningFeedback={setNotice} />}
    </div>
  );
}

function SignInScreen({
  configured,
  showDemoPreview,
  error,
  onSignIn,
  onSignUp,
  onDemoPreview,
}: {
  configured: boolean;
  showDemoPreview: boolean;
  error: string | null;
  onSignIn: () => void;
  onSignUp: () => void;
  onDemoPreview: () => void;
}) {
  return <main className="auth-screen">
    <div className="auth-panel">
      <a className="wordmark auth-wordmark" href="/" aria-label="The Club home"><span className="wordmark-stamp">L</span><span className="wordmark-name">the club<span className="wordmark-period">.</span></span></a>
      <div className="eyebrow"><span className="eyebrow-line" />MEMBER ACCESS</div>
      <h1>{configured ? "Your club, in one place." : "Connect your sign-in provider."}</h1>
      <p>{configured ? "Sign in to view your tickets, club activity, and drawing results." : "The authenticated API is ready, but this deployment still needs its OIDC issuer and client ID configured."}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {configured && <button className="button button-primary auth-button" onClick={onSignIn}>Sign in securely <ArrowUpRight size={16} /></button>}
      {configured && <button className="button button-secondary auth-button" onClick={onSignUp}>Create an account</button>}
      {showDemoPreview && <button className="button button-secondary auth-button" onClick={onDemoPreview}>Preview with demo data</button>}
      <div className="auth-footnote"><ShieldCheck size={14} />Your identity provider handles account creation and email verification. Passwords are never stored here.</div>
    </div>
    <div className="auth-rail"><div className="auth-rail-mark">L</div><span>MEMBER-OWNED RECORDS</span></div>
  </main>;
}

function OverviewView({ data, onNavigate }: { data: ClubOverview; onNavigate: (view: View) => void }) {
  const pendingDraws = data.results.filter((item) => item.drawing.status === "pending").sort((a, b) => a.drawing.drawingDate.localeCompare(b.drawing.drawingDate));
  const recentContributions = data.contributions.slice(0, 5);
  const totalsByMember = data.members.map((member) => ({ ...member, total: data.contributions.filter((item) => item.userId === member.userId).reduce((sum, item) => sum + item.costUsd, 0) }));
  const maxSpend = Math.max(...totalsByMember.map((member) => member.total), 1);

  return (
    <>
      <section className="metric-grid" aria-label="Club metrics">
        <Metric label="Active members" value={String(data.members.length).padStart(2, "0")} note="All in good standing" accent="mint" icon={<Users size={17} />} />
        <Metric label="Tickets recorded" value={String(data.contributions.length).padStart(2, "0")} note="Across both lotteries" accent="lemon" icon={<Ticket size={17} />} />
        <Metric label="Contributions" value={money(data.totalContributionsUsd)} note="Recorded spend, not collected" accent="peach" icon={<ArrowUpRight size={17} />} />
        <Metric label="Gross prizes won" value={money(data.totalGrossPrizesUsd)} note="Before any sharing rules" accent="blue" icon={<Trophy size={17} />} />
      </section>

      <section className="next-draw-section">
        <div className="section-heading">
          <div><span className="section-kicker">ON THE HORIZON</span><h2>Next drawings</h2></div>
          <span className="live-status"><span />Official estimates</span>
        </div>
        <div className="draw-grid">
          {pendingDraws.map(({ drawing }) => (
            <article className={`draw-card draw-${drawing.lottery}`} key={drawing.id}>
              <div className="draw-card-top">
                <LotteryBadge lottery={drawing.lottery} />
                <span className="draw-status"><Clock3 size={13} />Scheduled</span>
              </div>
              <div className="draw-jackpot-label">ESTIMATED JACKPOT</div>
              <div className="draw-jackpot">{drawing.estimatedJackpot ? compactMoney(drawing.estimatedJackpot) : "Pending"}</div>
              <div className="draw-card-bottom">
                <span>{formatDate(drawing.drawingDate, { weekday: "short", month: "short", day: "numeric" })}</span>
                <span>Cash value {drawing.cashValue ? compactMoney(drawing.cashValue) : "—"}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="overview-lower">
        <div className="activity-section">
          <div className="section-heading section-heading-inline">
            <div><span className="section-kicker">THE PAPER TRAIL</span><h2>Recent contributions</h2></div>
            <button className="text-button" onClick={() => onNavigate("contributions")}>View all <ArrowUpRight size={15} /></button>
          </div>
          <div className="contribution-list">
            {recentContributions.map((contribution) => {
              const member = data.members.find((item) => item.userId === contribution.userId);
              return <ContributionRow key={contribution.id} contribution={contribution} memberName={member?.displayName ?? "Member"} />;
            })}
          </div>
        </div>
        <aside className="club-snapshot">
          <div className="section-heading section-heading-inline">
            <div><span className="section-kicker">WHO'S IN</span><h2>Member activity</h2></div>
            <button className="text-button" onClick={() => onNavigate("members")}>Members <ArrowUpRight size={15} /></button>
          </div>
          <div className="spend-list">
            {totalsByMember.map((member, index) => (
              <div className="spend-item" key={member.id}>
                <span className={`member-avatar avatar-${index % 5}`}>{member.initials}</span>
                <span className="spend-name">{member.displayName.split(" ")[0]}</span>
                <span className="spend-track"><span style={{ width: `${Math.max(6, member.total / maxSpend * 100)}%` }} /></span>
                <span className="spend-total">{money(member.total)}</span>
              </div>
            ))}
          </div>
          <div className="snapshot-note"><LockKeyhole size={14} />Members only · Private club</div>
        </aside>
      </section>

      <section className="results-strip">
        <div className="results-strip-copy"><span className="section-kicker">LAST DRAW</span><h2>Results, without the guesswork.</h2><p>Official numbers are labeled separately from estimated payouts.</p></div>
        <div className="result-preview">
          {data.results.filter((item) => ["calculated", "recalculated"].includes(drawingResultState(item.result))).slice(0, 2).map((item) => (
            <div className="result-preview-row" key={item.drawing.id}>
              <LotteryBadge lottery={item.drawing.lottery} compact />
              <span>{formatDate(item.drawing.drawingDate)}</span>
              <span className="result-preview-won">{item.winningTicketCount ? `${item.winningTicketCount} winning ticket` : "No club winner"}</span>
              <strong>{item.grossPrizeTotal ? money(item.grossPrizeTotal) : "—"}</strong>
            </div>
          ))}
        </div>
        <button className="results-link" onClick={() => onNavigate("results")} aria-label="View all results"><ChevronRight size={20} /></button>
      </section>
    </>
  );
}

function Metric({ label, value, note, accent, icon }: { label: string; value: string; note: string; accent: string; icon: ReactNode }) {
  return <article className={`metric metric-${accent}`}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{note}</small></article>;
}

function ContributionsView({ api, currentUserId, contributions, members, onAdd, onEdit }: { api: ClubApi; currentUserId: string; contributions: Contribution[]; members: ClubMemberView[]; onAdd: () => void; onEdit: (contribution: Contribution) => void }) {
  const [filter, setFilter] = useState<"all" | LotteryType>("all");
  const [photoId, setPhotoId] = useState<string | null>(null);
  const visible = filter === "all" ? contributions : contributions.filter((item) => item.lottery === filter);
  return (
    <section className="data-section">
      <div className="data-toolbar"><div className="segmented-control" role="group" aria-label="Filter by lottery">
        {(["all", "powerball", "mega_millions"] as const).map((value) => <button key={value} className={filter === value ? "segment-active" : ""} onClick={() => setFilter(value)}>{value === "all" ? "All tickets" : lotteryName(value)}</button>)}
      </div><button className="button button-secondary" onClick={onAdd}><Plus size={15} />Add ticket</button></div>
      <div className="table-wrap"><table><thead><tr><th>Ticket / lottery</th><th>Member</th><th>Draw date</th><th>Selections</th><th>Draws</th><th>Cost</th><th>Status</th></tr></thead>
        <tbody>{visible.map((item) => {
          const member = members.find((candidate) => candidate.userId === item.userId);
          const sets = item.numberSets as { numbers?: number[]; bonusNumber?: string | number }[];
          return <tr key={item.id}><td><LotteryBadge lottery={item.lottery} compact /></td><td>{member?.displayName ?? "Member"}</td><td>{formatDate(item.drawingDate, { month: "short", day: "numeric", year: "numeric" })}</td><td><span className="ticket-number-sets">{sets.map((set, index) => <NumberSet key={index} numbers={set.numbers ?? []} bonus={set.bonusNumber} lottery={item.lottery} />)}</span></td><td>{item.drawingCount}</td><td className="money-cell">{money(item.costUsd)}</td><td><span className="ticket-status">{item.userId === currentUserId && item.canEdit && <button className="icon-button ticket-photo-button" type="button" title="Edit ticket" aria-label={`Edit ticket for ${member?.displayName ?? "member"}`} onClick={() => onEdit(item)}><Pencil size={15} /></button>}<StatusTag label="Submitted" tone="neutral" />{item.hasTicketPhoto && <button className="icon-button ticket-photo-button" type="button" title="View ticket photo" aria-label={`View ticket photo for ${member?.displayName ?? "member"}`} onClick={() => setPhotoId(item.id)}><ImageIcon size={16} /></button>}</span></td></tr>;
        })}</tbody></table>
      </div>
      <div className="table-footnote"><Eye size={14} />Ticket records are visible to club members. The app does not verify physical tickets.</div>
      {photoId && contributions.find((item) => item.id === photoId) && <TicketPhotoDialog api={api} currentUserId={currentUserId} ticket={contributions.find((item) => item.id === photoId)!} onClose={() => setPhotoId(null)} />}
    </section>
  );
}

function TicketPhotoDialog({ api, currentUserId, ticket, onClose }: { api: ClubApi; currentUserId: string; ticket: Contribution; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [consent, setConsent] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    api.getContributionPhoto(ticket.id).then((photo) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(photo);
      setPhoto(photo);
      setUrl(objectUrl);
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Ticket photo could not be loaded."); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, ticket.id]);
  const remember = async () => {
    if (!photo || !consent) return;
    setRemembering(true);
    setError(null);
    try {
      const storage = readerStorage();
      if (!storage) throw new Error("Reader learning is unavailable on this browser.");
      const fingerprint = await photoFingerprint(photo);
      const plays = ticket.numberSets.map((set) => ({ numbers: Array.isArray(set.numbers) ? set.numbers.map(Number) : [], bonusNumber: Number(set.bonusNumber) }));
      const current = loadOcrModel(storage, currentUserId);
      const updated = rememberPhotoExample(current, fingerprint, ticket.lottery, plays);
      if (updated === current) {
        if (!current.examples.some((example) => example.photoHash === fingerprint && example.lottery === ticket.lottery && JSON.stringify(example.plays) === JSON.stringify(plays))) throw new Error("This ticket's saved plays cannot be used as an example.");
        setMessage("This photo is already remembered on this browser.");
      } else {
        if (!saveOcrModel(storage, currentUserId, updated)) throw new Error("Reader learning could not be saved on this browser.");
        setMessage("This exact photo and its plays are remembered on this browser.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This photo could not be remembered.");
    } finally {
      setRemembering(false);
    }
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="contribution-dialog photo-dialog" role="dialog" aria-modal="true" aria-labelledby="photo-title">
      <div className="dialog-head"><h2 id="photo-title">Ticket photo</h2><button className="icon-button" type="button" onClick={onClose} aria-label="Close photo"><X size={18} /></button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {url ? <img src={url} alt="Uploaded lottery ticket" /> : !error && <p>Loading photo...</p>}
      {photo && ticket.userId === currentUserId && <div className="ocr-learning photo-learning"><label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />I checked these plays and agree to remember them on this browser.</label><p>The plays and a photo fingerprint are stored locally. This can suggest them only for the exact same photo.</p><button className="button button-secondary" type="button" disabled={!consent || remembering} onClick={remember}>{remembering ? "Saving..." : "Remember this photo"}</button>{message && <p role="status">{message}</p>}</div>}
    </section>
  </div>;
}

function ResultsView({ results }: { results: DrawingResultView[] }) {
  const [expandedDrawingId, setExpandedDrawingId] = useState<string | null>(null);
  return <section className="results-table-list">{results.map(({ drawing, result, winningTicketCount, grossPrizeTotal, payouts }) => {
    const state = drawingResultState(result);
    const calculated = state === "calculated" || state === "recalculated";
    const label = state === "pending_results" ? "Pending results" : state === "pending_calculation" ? "Pending calculation" : state === "recalculated" ? "Recalculated" : "Calculated";
    return (
    <Fragment key={drawing.id}>
    <article className="result-record">
      <div className="result-record-date"><span>{formatDate(drawing.drawingDate, { month: "short", day: "numeric" })}</span><small>{formatDate(drawing.drawingDate, { year: "numeric" })}</small></div>
      <div className="result-record-main"><LotteryBadge lottery={drawing.lottery} compact /><strong>{lotteryName(drawing.lottery)}</strong><span>{state === "pending_results" ? "Official result pending" : "Official result posted"}</span></div>
      {state !== "pending_results" ? <NumberSet numbers={(result?.officialWinningNumbers?.numbers as number[]) ?? []} bonus={String(result?.officialWinningNumbers?.bonusNumber ?? "")} lottery={drawing.lottery} /> : <span className="pending-copy"><Clock3 size={14} />Numbers pending</span>}
      <div className="result-record-total"><small>{calculated && winningTicketCount ? `${winningTicketCount} winning ticket` : "Gross club prizes"}</small><strong>{calculated ? money(grossPrizeTotal) : "—"}</strong></div>
      <StatusTag label={label} tone={calculated ? "success" : "warning"} />
    </article>
    {calculated && payouts.length > 0 && <div className="payout-breakdown">
      <button className="text-button payout-toggle" type="button" aria-expanded={expandedDrawingId === drawing.id} onClick={() => setExpandedDrawingId((current) => current === drawing.id ? null : drawing.id)}>{expandedDrawingId === drawing.id ? "Hide payouts" : `View ${payouts.length} payout${payouts.length === 1 ? "" : "s"}`}<ChevronDown size={14} /></button>
      {expandedDrawingId === drawing.id && <div className="payout-list" role="region" aria-label={`${lotteryName(drawing.lottery)} payout allocation`}>
        <div className="payout-list-heading"><span>Member</span><span>Gross prize</span><span>Allocated share</span></div>
        {payouts.map((payout) => <div className="payout-row" key={`${drawing.id}-${payout.userId}-${payout.prizeType}`}><span>{payout.memberName}</span><span>{money(payout.grossPrizeAmount)}</span><strong>{money(payout.shareAmount)}</strong></div>)}
        <p className="payout-note">Recorded allocations only. No money is transferred by the app.</p>
      </div>}
    </div>}
    </Fragment>
    );
  })}</section>;
}

function DiscoveryView({ api, onOpenClub }: { api: ClubApi; onOpenClub: (clubId: string) => Promise<MembershipActionResult> }) {
  const [query, setQuery] = useState("");
  const [clubs, setClubs] = useState<ClubDiscoverySummary[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (query.trim().length < 2) { setError("Enter at least two characters."); return; }
    setLoading(true);
    setError(null);
    try {
      setClubs(await api.searchClubs(query.trim()));
      setSearched(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Clubs could not be searched.");
    } finally {
      setLoading(false);
    }
  };

  const openClub = async (clubId: string) => {
    setError(null);
    try {
      const membership = await onOpenClub(clubId);
      if (membership.status === "pending" && query.trim().length >= 2) setClubs(await api.searchClubs(query.trim()));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Membership could not be updated."); }
  };

  return <section className="data-section discovery-section">
    <form className="discovery-search" onSubmit={search}>
      <label className="sr-only" htmlFor="club-discovery-search">Club name</label>
      <Search size={18} aria-hidden="true" />
      <input id="club-discovery-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by club name" maxLength={80} />
      <button className="button button-primary" type="submit" disabled={loading}>{loading ? "Searching..." : "Search"}</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    {searched && clubs.length === 0 && <p className="discovery-empty">No searchable clubs match that name.</p>}
    <div className="discovery-list">
      {clubs.map((item) => {
        const active = item.membershipStatus === "active";
        const pending = item.membershipStatus === "pending";
        const label = active ? "Open club" : pending ? "Request pending" : item.visibility === "public" ? "Join club" : "Request access";
        return <article className="discovery-row" key={item.id}>
          <div className="discovery-club-mark">{item.visibility === "private" ? <LockKeyhole size={18} /> : <Users size={18} />}</div>
          <div className="discovery-club-copy">
            <div className="discovery-club-title"><h2>{item.name}</h2><span>{item.visibility}</span></div>
            {item.visibility === "public" && <p>{item.description || item.motto || `${item.memberCount} active ${item.memberCount === 1 ? "member" : "members"}`}</p>}
          </div>
          <button className="button button-secondary" type="button" disabled={pending || api.mode !== "oidc"} onClick={() => void openClub(item.id)}>{api.mode === "demo" ? "Preview only" : label}</button>
        </article>;
      })}
    </div>
  </section>;
}

function MembersView({ data, api, onAction }: { data: ClubOverview; api: ClubApi; onAction: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const currentMember = data.members.find((member) => member.userId === data.currentUser.id);
  const role = currentMember?.role ?? "member";
  const canModerate = api.mode === "oidc" && (role === "creator" || role === "admin");
  const isCreator = api.mode === "oidc" && role === "creator";
  const [requests, setRequests] = useState<MembershipRequestView[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!canModerate) return;
    let mounted = true;
    api.getMembershipRequests().then((items) => { if (mounted) setRequests(items); }).catch((cause: unknown) => {
      if (mounted) setRequestError(cause instanceof Error ? cause.message : "Membership requests could not be loaded.");
    });
    return () => { mounted = false; };
  }, [api, canModerate, data.club.id]);

  const runAction = async (action: () => Promise<unknown>, message: string) => {
    setActionError(null);
    try {
      await onAction(action, message);
      if (canModerate) setRequests(await api.getMembershipRequests());
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Membership could not be updated.");
    }
  };

  return <section className="data-section member-section">
    <div className="member-intro"><div><span className="section-kicker">THE ROSTER</span><h2>{data.members.length} members, one shared pool.</h2><p>Only eligible members are included in each drawing's payout calculation.</p></div><span className="private-pill">{data.club.visibility === "private" ? <LockKeyhole size={13} /> : <Users size={13} />}{data.club.visibility}</span></div>
    {(canModerate || currentMember?.role !== "creator") && <div className="membership-toolbar">
      {canModerate && <span>{requests.length} pending {requests.length === 1 ? "request" : "requests"}</span>}
      {currentMember?.role !== "creator" && api.mode === "oidc" && <button className="button button-secondary" type="button" onClick={() => window.confirm("Leave this club? You will lose eligibility for future drawings.") && void runAction(() => api.leaveClub(), "You left the club.")}>Leave club</button>}
    </div>}
    {requestError && <p className="form-error" role="alert">{requestError}</p>}
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {canModerate && requests.length > 0 && <div className="request-list" aria-label="Pending membership requests">
      {requests.map((request) => <div className="request-row" key={request.membershipId}>
        <span className="request-person"><strong>{request.displayName}</strong><small>{request.email}</small></span>
        <span className="request-date">Requested {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(request.requestedAt))}</span>
        <div className="request-actions"><button className="button button-secondary" type="button" onClick={() => void runAction(() => api.rejectMembership(request.userId), "Request declined.")}>Decline</button><button className="button button-primary" type="button" onClick={() => void runAction(() => api.approveMembership(request.userId), "Member approved.")}>Approve</button></div>
      </div>)}
    </div>}
    <div className="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Tickets</th><th>Contributions</th><th>Joined</th><th>Eligibility</th>{isCreator && <th>Manage</th>}</tr></thead><tbody>
      {data.members.map((member, index) => <tr key={member.id}><td><span className="member-table-name"><span className={`member-avatar avatar-${index % 5}`}>{member.initials}</span><span><strong>{member.displayName}</strong><small>{member.email}</small></span></span></td><td><StatusTag label={member.role} tone={member.role === "creator" ? "mint" : "neutral"} /></td><td>{member.ticketCount}</td><td className="money-cell">{money(member.contributionTotalUsd)}</td><td>{formatDate(member.joinedAt.slice(0, 10), { month: "short", day: "numeric" })}</td><td><span className="eligible-label"><span />Eligible for next draw</span></td>{isCreator && <td><div className="member-actions">{member.role !== "creator" && member.userId !== data.currentUser.id && <><button className="text-action" type="button" onClick={() => void runAction(() => api.updateMembershipRole(member.userId, member.role === "admin" ? "member" : "admin"), member.role === "admin" ? "Admin role removed." : "Admin role granted.")}>{member.role === "admin" ? "Remove admin" : "Make admin"}</button><button className="text-action text-action-danger" type="button" onClick={() => window.confirm(`Remove ${member.displayName} from this club?`) && void runAction(() => api.removeMember(member.userId), "Member removed.")}>Remove</button></>}</div></td>}</tr>)}
    </tbody></table></div>
  </section>;
}

function ContributionRow({ contribution, memberName }: { contribution: Contribution; memberName: string }) {
  const selection = contribution.numberSets[0] as { numbers?: number[]; bonusNumber?: string | number };
  return <div className="contribution-row">
    <LotteryBadge lottery={contribution.lottery} compact />
    <span className="contribution-member">{memberName}<small>{formatDate(contribution.createdAt.slice(0, 10))}</small></span>
    <span className="contribution-numbers"><NumberSet numbers={selection.numbers ?? []} bonus={selection.bonusNumber} lottery={contribution.lottery} />{contribution.numberSets.length > 1 && <small>+{contribution.numberSets.length - 1} plays</small>}</span>
    <span className="contribution-draws">{contribution.drawingCount} {contribution.drawingCount === 1 ? "draw" : "draws"}</span>
    <strong className="contribution-cost">{money(contribution.costUsd)}</strong>
  </div>;
}

function LotteryBadge({ lottery, compact = false }: { lottery: LotteryType; compact?: boolean }) {
  return <span className={`lottery-badge ${lottery === "powerball" ? "badge-powerball" : "badge-mega"} ${compact ? "lottery-badge-compact" : ""}`}><span className="lottery-ball">{lottery === "powerball" ? "P" : "M"}</span>{compact ? <span className="sr-only">{lotteryName(lottery)}</span> : lotteryName(lottery)}</span>;
}

function NumberSet({ numbers, bonus, lottery }: { numbers: number[]; bonus?: string | number | null; lottery: LotteryType }) {
  return <span className="number-set">{numbers.map((number, index) => <span className="number-ball" key={`${number}-${index}`}>{number}</span>)}{bonus != null && bonus !== "" && <span className={`number-ball number-bonus ${lottery === "mega_millions" ? "number-mega" : ""}`}>{bonus}</span>}</span>;
}

function StatusTag({ label, tone }: { label: string; tone: "success" | "warning" | "neutral" | "mint" }) {
  return <span className={`status-tag status-${tone}`}><span />{label}</span>;
}

function ClubSettingsDialog({ club, members, currentUserId, canManageOwnership, onClose, onSubmit, onTransferOwnership, onCloseClub }: {
  club: Club;
  members: ClubMemberView[];
  currentUserId: string;
  canManageOwnership: boolean;
  onClose: () => void;
  onSubmit: (input: UpdateClubSettingsRequest) => Promise<void>;
  onTransferOwnership: (userId: string) => Promise<void>;
  onCloseClub: () => Promise<void>;
}) {
  const [name, setName] = useState(club.name);
  const [description, setDescription] = useState(club.description ?? "");
  const [motto, setMotto] = useState(club.motto ?? "");
  const [visibility, setVisibility] = useState(club.visibility);
  const [allowSearch, setAllowSearch] = useState(club.allowSearch);
  const [newOwnerUserId, setNewOwnerUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isCreator = canManageOwnership && members.some((member) => member.userId === currentUserId && member.role === "creator");
  const admins = members.filter((member) => member.role === "admin" && member.userId !== currentUserId);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || null,
        motto: motto.trim() || null,
        visibility,
        allowSearch: visibility === "public" || allowSearch,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Club settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const runGovernanceAction = async (action: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Club management action could not be completed."); }
    finally { setSaving(false); }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="contribution-dialog create-club-dialog" role="dialog" aria-modal="true" aria-labelledby="club-settings-title">
      <div className="dialog-head"><div><span className="section-kicker">CLUB</span><h2 id="club-settings-title">Club settings</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" disabled={saving}><X size={18} /></button></div>
      <form onSubmit={submit}>
        <label className="field-label">Club name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></label>
        <label className="field-label">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={2} /></label>
        <label className="field-label">Motto<input value={motto} onChange={(event) => setMotto(event.target.value)} maxLength={200} /></label>
        <label className="field-label">Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as Club["visibility"])}><option value="private">Private</option><option value="public">Public</option></select></label>
        {visibility === "private" && <label className="club-setting-toggle"><input type="checkbox" checked={allowSearch} onChange={(event) => setAllowSearch(event.target.checked)} />Allow this private club to appear in search</label>}
        <p className="photo-help">Payout configuration and supported lotteries are fixed when the club is created.</p>
        {isCreator && <section className="club-governance">
          <div><span className="section-kicker">OWNERSHIP</span><p>Transfer the Creator role to an active Admin. Promote a member from the roster first if needed.</p></div>
          <label className="field-label">New owner<select value={newOwnerUserId} onChange={(event) => setNewOwnerUserId(event.target.value)} disabled={!admins.length || saving}><option value="">{admins.length ? "Select an Admin" : "No Admins available"}</option>{admins.map((admin) => <option key={admin.userId} value={admin.userId}>{admin.displayName}</option>)}</select></label>
          <button className="button button-secondary" type="button" disabled={!newOwnerUserId || saving} onClick={() => window.confirm("Transfer ownership? You will become an Admin.") && void runGovernanceAction(() => onTransferOwnership(newOwnerUserId))}>Transfer ownership</button>
          <div className="club-close-action"><p>Close this club when it has no future contributions or incomplete payouts.</p><button className="button button-danger" type="button" disabled={saving} onClick={() => window.confirm("Close this club? Members will lose access to future club activity.") && void runGovernanceAction(onCloseClub)}>Close club</button></div>
        </section>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="button button-secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? "Saving..." : "Save settings"}</button></div>
      </form>
    </section>
  </div>;
}

function AccountDialog({ user, onClose, onSignOut, onCloseAccount }: { user: User; onClose: () => void; onSignOut: () => Promise<void>; onCloseAccount: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The account action could not be completed."); }
    finally { setBusy(false); }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirmation !== "CLOSE") { setError('Type "CLOSE" to confirm account closure.'); return; }
    void run(onCloseAccount);
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="contribution-dialog account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
      <div className="dialog-head"><div><span className="section-kicker">ACCOUNT</span><h2 id="account-dialog-title">Your account</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close account dialog" disabled={busy}><X size={18} /></button></div>
      <div className="account-identity"><span className="profile-avatar">{userInitials(user.displayName)}</span><span><strong>{user.displayName}</strong><small>{user.email}</small></span></div>
      <p className="account-retention">Closing your account disables sign-in. Existing club records remain available to club members. Transfer ownership or close all active clubs first.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!confirming ? <div className="dialog-actions account-actions"><button className="button button-secondary" type="button" onClick={() => void run(onSignOut)} disabled={busy}>{busy ? "Working..." : "Sign out"}</button><button className="button button-danger" type="button" onClick={() => { setError(null); setConfirming(true); }}>Close account</button></div> : <form onSubmit={submit}>
        <label className="field-label">Type CLOSE to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" required /></label>
        <div className="dialog-actions"><button className="button button-secondary" type="button" onClick={() => { setConfirming(false); setConfirmation(""); setError(null); }} disabled={busy}>Cancel</button><button className="button button-danger" type="submit" disabled={busy || confirmation !== "CLOSE"}>{busy ? "Closing..." : "Close account"}</button></div>
      </form>}
    </section>
  </div>;
}

function CreateClubDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (input: CreateClubRequest) => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [supportedLotteries, setSupportedLotteries] = useState<LotteryType[]>(["powerball", "mega_millions"]);
  const [payoutType, setPayoutType] = useState<CreateClubRequest["payoutConfiguration"]["type"]>("equal_shares");
  const [thresholdAmount, setThresholdAmount] = useState("100");
  const [thresholdMethod, setThresholdMethod] = useState<"pooled" | "individual">("pooled");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(thresholdAmount);
    if (!supportedLotteries.length) { setError("Select at least one lottery."); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setError("Enter a threshold greater than zero."); return; }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || null,
        visibility,
        supportedLotteries,
        allowSearch: visibility === "public",
        payoutConfiguration: { type: payoutType },
        thresholdRule: { thresholdAmount: amount, method: thresholdMethod },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The club could not be created.");
    } finally {
      setSaving(false);
    }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="contribution-dialog create-club-dialog" role="dialog" aria-modal="true" aria-labelledby="create-club-title">
      <div className="dialog-head"><div><span className="section-kicker">NEW WORKSPACE</span><h2 id="create-club-title">Create a club</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" disabled={saving}><X size={18} /></button></div>
      <form onSubmit={submit}>
        <label className="field-label">Club name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoFocus /></label>
        <label className="field-label">Description (optional)<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={2} /></label>
        <div className="field-grid">
          <label className="field-label">Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as "private" | "public")}><option value="private">Private</option><option value="public">Public</option></select></label>
          <label className="field-label">Payout style<select value={payoutType} onChange={(event) => setPayoutType(event.target.value as CreateClubRequest["payoutConfiguration"]["type"])}><option value="equal_shares">Equal shares</option><option value="proportion_drawing_specific">Proportional by drawing</option><option value="proportion_all_drawings">Proportional across all drawings</option></select></label>
        </div>
        <fieldset className="club-lottery-fields"><legend>Supported lotteries</legend>{(["powerball", "mega_millions"] as const).map((lottery) => <label key={lottery}><input type="checkbox" checked={supportedLotteries.includes(lottery)} onChange={(event) => setSupportedLotteries((current) => event.target.checked ? [...current, lottery] : current.filter((value) => value !== lottery))} />{lotteryName(lottery)}</label>)}</fieldset>
        <div className="field-grid">
          <label className="field-label">Threshold amount ($)<input type="number" min="0.01" step="0.01" value={thresholdAmount} onChange={(event) => setThresholdAmount(event.target.value)} required /></label>
          <label className="field-label">Threshold method<select value={thresholdMethod} onChange={(event) => setThresholdMethod(event.target.value as "pooled" | "individual")}><option value="pooled">Pooled winnings</option><option value="individual">Individual prizes</option></select></label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <p className="photo-help">We’ll prepare upcoming drawings and fetch official rules and ticket prices before opening ticket entry.</p>
        <div className="dialog-actions"><button className="button button-secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? "Preparing club..." : "Create club"}</button></div>
      </form>
    </section>
  </div>;
}

function ContributionDialog({ api, userId, editingContribution, onClose, onSubmit, onLearningFeedback }: { api: ClubApi; userId: string; editingContribution?: Contribution; onClose: () => void; onSubmit: (input: CreateContributionInput, photo?: File) => Promise<void>; onLearningFeedback: (message: string) => void }) {
  const [lottery, setLottery] = useState<LotteryType>(editingContribution?.lottery ?? "powerball");
  const [drawingDate, setDrawingDate] = useState(editingContribution?.drawingDate ?? "");
  const [drawingCount, setDrawingCount] = useState(editingContribution?.drawingCount ?? 1);
  const [plays, setPlays] = useState(() => {
    const savedSets = editingContribution?.numberSets as { numbers?: number[]; bonusNumber?: string | number }[] | undefined;
    return savedSets?.length
      ? savedSets.map((set) => ({ id: crypto.randomUUID(), numbersText: (set.numbers ?? []).join(", "), bonusText: String(set.bonusNumber ?? "") }))
      : [{ id: crypto.randomUUID(), numbersText: "", bonusText: "" }];
  });
  const [options, setOptions] = useState<TicketDrawingOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [refreshingPricing, setRefreshingPricing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState<{ plays: TicketNumberSetInput[]; unrecognizedLines: number; source?: "remembered" } | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [learningConsent, setLearningConsent] = useState(false);
  const [learningCount, setLearningCount] = useState(() => {
    const storage = readerStorage();
    if (!storage) return 0;
    const model = loadOcrModel(storage, userId);
    return Object.keys(model.corrections).length + model.examples.length;
  });
  const [ocrApplied, setOcrApplied] = useState(false);
  const [ocrUnrecognized, setOcrUnrecognized] = useState(0);
  const [ocrConfirmed, setOcrConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [activeNumber, setActiveNumber] = useState<{ playId: string; slot: number } | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const selected = options.find((option) => option.lottery === lottery && option.drawingDate === drawingDate);
  const rules = selected?.numberRules;
  const lotteries = [...new Set(options.map((option) => option.lottery))];
  const canLearn = ocrText !== null && hasLearnableOcrRows(ocrText);
  const needsPricingRefresh = Boolean(drawingDate) && (!selected || selected.ticketPrice == null || !selected.numberRules);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!photo) { setPhotoPreview(null); return; }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  useEffect(() => {
    let active = true;
    api.getTicketDrawingOptions().then((available) => {
      if (!active) return;
      setOptions(available);
      const firstLottery = editingContribution?.lottery ?? available[0]?.lottery;
      if (firstLottery) {
        setLottery(firstLottery);
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        setDrawingDate(editingContribution?.drawingDate ?? available.find((option) => option.lottery === firstLottery && option.drawingDate >= today)?.drawingDate ?? "");
      }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Drawing options could not be loaded.");
    }).finally(() => { if (active) setLoadingOptions(false); });
    return () => { active = false; };
  }, [api, editingContribution]);

  const handleLotteryChange = (next: LotteryType) => {
    setLottery(next);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    setDrawingDate(options.find((option) => option.lottery === next && option.drawingDate >= today)?.drawingDate ?? "");
    setDrawingCount(1);
    setPlays([{ id: crypto.randomUUID(), numbersText: "", bonusText: "" }]);
    setActiveNumber(null);
    setOcrResult(null);
    setOcrText(null);
    setLearningConsent(false);
    setOcrApplied(false);
    setOcrConfirmed(false);
    setError(null);
  };

  const refreshPricing = async () => {
    setRefreshingPricing(true);
    setError(null);
    try {
      const refreshed = await api.getTicketDrawingOptions();
      setOptions(refreshed);
      const current = refreshed.find((option) => option.lottery === lottery && option.drawingDate === drawingDate);
      if (!current?.numberRules || current.ticketPrice == null) {
        setError("Official ticket pricing is still unavailable for this drawing.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ticket pricing could not be refreshed.");
    } finally {
      setRefreshingPricing(false);
    }
  };

  const chooseNumber = (playId: string, slot: number, value: number) => {
    if (!rules) return;
    const play = plays.find((item) => item.id === playId);
    if (!play) return;
    const existing = play.numbersText.split(",").map((number) => number.trim());
    const numbers = Array.from({ length: rules.mainNumberCount }, (_, index) => existing[index] ?? "");
    if (slot === rules.mainNumberCount) {
      setPlays((current) => current.map((item) => item.id === playId ? { ...item, bonusText: String(value) } : item));
      setActiveNumber(null);
    } else {
      numbers[slot] = String(value);
      setPlays((current) => current.map((item) => item.id === playId ? { ...item, numbersText: numbers.join(",") } : item));
      const next = numbers.findIndex((number) => !number);
      setActiveNumber(next >= 0 ? { playId, slot: next } : !play.bonusText ? { playId, slot: rules.mainNumberCount } : null);
    }
    if (ocrApplied) setOcrConfirmed(false);
    setLearningConsent(false);
    setError(null);
  };

  const readPhoto = async () => {
    if (!photo || !rules) return;
    setReading(true);
    setError(null);
    setOcrResult(null);
    setOcrText(null);
    try {
      const storage = readerStorage();
      const model = storage ? loadOcrModel(storage, userId) : emptyOcrModel();
      let remembered: TicketNumberSetInput[] | null = null;
      try { remembered = findPhotoExample(model, await photoFingerprint(photo), lottery, rules); } catch { remembered = null; }
      if (remembered) {
        if (mounted.current) setOcrResult({ plays: remembered, unrecognizedLines: 0, source: "remembered" });
        return;
      }
      const { readTicketPhoto } = await import("./api/ticket-ocr");
      const text = await readTicketPhoto(photo);
      const result = parseWithOcrModel(text, rules, model);
      if (!mounted.current) return;
      if (result.plays.length > (selected?.maxNumberSets ?? 10)) throw new Error(`More than ${selected?.maxNumberSets ?? 10} number sets were detected. Enter or combine them manually.`);
      setOcrText(text);
      setOcrResult(result);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "The ticket photo could not be read.");
    } finally {
      if (mounted.current) setReading(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numberSets = plays.map((play) => ({ numbers: play.numbersText.split(",").map((value) => Number(value.trim())), bonusNumber: Number(play.bonusText) }));
    if (!selected || !rules || selected.ticketPrice === null) {
      setError("Official ticket rules and pricing are not available for this drawing.");
      return;
    }
    if (ocrApplied && !ocrConfirmed) {
      setError("Confirm that you checked every play against the ticket.");
      return;
    }
    for (const [index, play] of numberSets.entries()) {
      if (play.numbers.length !== rules.mainNumberCount || play.numbers.some((number) => !Number.isInteger(number) || number < rules.mainNumberMin || number > rules.mainNumberMax) || new Set(play.numbers).size !== rules.mainNumberCount) {
        setError(`Play ${index + 1}: enter ${rules.mainNumberCount} unique numbers from ${rules.mainNumberMin} to ${rules.mainNumberMax}.`);
        return;
      }
      if (!Number.isInteger(play.bonusNumber) || play.bonusNumber < rules.bonusNumberMin || play.bonusNumber > rules.bonusNumberMax) {
        setError(`Play ${index + 1}: enter a ${bonusName(lottery)} number from ${rules.bonusNumberMin} to ${rules.bonusNumberMax}.`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      let fingerprint: string | null = null;
      let learningMessage: string | null = null;
      if (learningConsent && photo) {
        try { fingerprint = await photoFingerprint(photo); } catch { learningMessage = "Contribution recorded, but reader learning is unavailable on this browser."; }
      }
      await onSubmit({ lottery, drawingDate, drawingCount, numberSets }, editingContribution ? undefined : photo ?? undefined);
      if (fingerprint) {
        const storage = readerStorage();
        if (!storage) {
          learningMessage = "Contribution recorded, but reader learning is unavailable on this browser.";
        } else {
          const current = loadOcrModel(storage, userId);
          const example = rememberPhotoExample(current, fingerprint, lottery, numberSets);
          const updated = ocrText ? learnOcrCorrections(example, ocrText, numberSets, fingerprint) : example;
          if (updated === current) learningMessage = "Contribution recorded. This photo is already remembered on this browser.";
          else learningMessage = saveOcrModel(storage, userId, updated)
            ? "Contribution recorded. This photo's plays are remembered on this browser."
            : "Contribution recorded, but reader learning could not be saved on this browser.";
        }
      }
      if (learningMessage) onLearningFeedback(learningMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The contribution could not be added. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="contribution-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <div className="dialog-head"><div><span className="section-kicker">{editingContribution ? "EDIT TICKET" : "NEW TICKET"}</span><h2 id="dialog-title">{editingContribution ? "Edit contribution" : "Add a contribution"}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      <form onSubmit={submit}>
        <label className="field-label">Lottery</label>
        <div className="lottery-choice">
          {lotteries.map((option) => <button type="button" disabled={reading || Boolean(editingContribution)} className={`lottery-option ${lottery === option ? "lottery-option-selected" : ""}`} onClick={() => handleLotteryChange(option)} key={option}><LotteryBadge lottery={option} />{lottery === option && <Check size={16} />}</button>)}
        </div>
        <div className="field-grid">
          <label className="field-label">Drawing date<select value={drawingDate} onChange={(event) => { setDrawingDate(event.target.value); setDrawingCount(1); setActiveNumber(null); setOcrResult(null); setOcrText(null); setLearningConsent(false); setError(null); }} required disabled={loadingOptions || reading}><option value="">Select a drawing</option>{options.filter((option) => option.lottery === lottery).map((option) => <option value={option.drawingDate} key={option.drawingDate}>{formatDate(option.drawingDate, { month: "short", day: "numeric", year: "numeric" })}</option>)}</select></label>
          <label className="field-label">Number of drawings<select value={drawingCount} onChange={(event) => setDrawingCount(Number(event.target.value))} disabled={!selected}>{(selected?.drawingCountOptions ?? [1]).map((count) => <option value={count} key={count}>{count} {count === 1 ? "drawing" : "drawings"}</option>)}</select></label>
        </div>
        {plays.map((play, index) => {
          const count = rules?.mainNumberCount ?? 5;
          const parts = play.numbersText.split(",").map((number) => number.trim());
          const numbers = Array.from({ length: count }, (_, numberIndex) => parts[numberIndex] ?? "");
          const activeSlot = activeNumber?.playId === play.id ? activeNumber.slot : null;
          const bonusActive = activeSlot === count;
          const minimum = bonusActive ? rules?.bonusNumberMin : rules?.mainNumberMin;
          const maximum = bonusActive ? rules?.bonusNumberMax : rules?.mainNumberMax;
          return <div className="play-entry" key={play.id}>
            <div className="play-heading"><strong>Play {index + 1}</strong>{plays.length > 1 && <button className="icon-button" type="button" title="Remove play" aria-label={`Remove play ${index + 1}`} onClick={() => { setPlays((current) => current.filter((item) => item.id !== play.id)); setOcrConfirmed(false); setLearningConsent(false); if (activeNumber?.playId === play.id) setActiveNumber(null); }}><Trash2 size={15} /></button>}</div>
            <div className="play-number-circles" role="group" aria-label={`Play ${index + 1} numbers`}>
              {numbers.map((number, numberIndex) => <button className={`play-number-circle ${activeSlot === numberIndex ? "play-number-active" : ""}`} type="button" disabled={!rules} key={numberIndex} aria-label={`Play ${index + 1} main number ${numberIndex + 1}${number ? `: ${number}` : ": empty"}`} aria-pressed={activeSlot === numberIndex} onClick={() => setActiveNumber({ playId: play.id, slot: numberIndex })}>{number ? number.padStart(2, "0") : "+"}</button>)}
              <button className={`play-number-circle play-number-bonus ${activeSlot === count ? "play-number-active" : ""}`} type="button" disabled={!rules} aria-label={`Play ${index + 1} ${bonusName(lottery)}${play.bonusText ? `: ${play.bonusText}` : ": empty"}`} aria-pressed={activeSlot === count} onClick={() => setActiveNumber({ playId: play.id, slot: count })}>{play.bonusText ? play.bonusText.padStart(2, "0") : "+"}</button>
            </div>
            {activeSlot !== null && minimum != null && maximum != null && <div className="number-picker" role="group" aria-label={bonusActive ? `Choose ${bonusName(lottery)} number` : "Choose main number"}>
              <div className="number-picker-heading"><strong>{bonusActive ? bonusName(lottery) : `Main number ${activeSlot + 1}`}</strong><button className="icon-button" type="button" title="Close number board" aria-label="Close number board" onClick={() => setActiveNumber(null)}><X size={15} /></button></div>
              <div className="number-picker-grid">{Array.from({ length: maximum - minimum + 1 }, (_, numberIndex) => {
                const value = numberIndex + minimum;
                const selectedValue = bonusActive ? Number(play.bonusText) : Number(numbers[activeSlot]);
                const used = !bonusActive && numbers.some((number, otherIndex) => otherIndex !== activeSlot && number !== "" && Number(number) === value);
                return <button className={`number-picker-option ${selectedValue === value ? "number-picker-selected" : ""}`} type="button" key={value} disabled={used} aria-label={`Select ${bonusActive ? bonusName(lottery) : "main number"} ${value}`} aria-pressed={selectedValue === value} onClick={() => chooseNumber(play.id, activeSlot, value)}>{String(value).padStart(2, "0")}</button>;
              })}</div>
            </div>}
          </div>;
        })}
        <button className="button button-secondary add-play-button" type="button" disabled={plays.length >= (selected?.maxNumberSets ?? 10)} onClick={() => { setPlays((current) => [...current, { id: crypto.randomUUID(), numbersText: "", bonusText: "" }]); setOcrConfirmed(false); setLearningConsent(false); }}><Plus size={15} />Add play</button>
        {!editingContribution && <>
        <label className="field-label">Ticket photo (optional)<input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" disabled={reading} onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          if (file && (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024 || file.size === 0)) {
            setPhoto(null);
            setOcrText(null);
            setLearningConsent(false);
            event.target.value = "";
            setError("Choose a JPEG, PNG, or WebP image up to 5 MB.");
            return;
          }
          setPhoto(file);
          setOcrResult(null);
          setOcrText(null);
          setLearningConsent(false);
          setOcrConfirmed(false);
          setError(null);
        }} /></label>
        <p className="photo-help">JPEG, PNG, or WebP up to 5 MB. Photos are stored with the contribution and visible to active club members.</p>
        {photo && photoPreview && <><div className="photo-preview"><img src={photoPreview} alt="Selected ticket" /><span>{photo.name}</span><button className="icon-button" type="button" title="Remove photo" aria-label="Remove photo" disabled={reading} onClick={() => { setPhoto(null); setOcrResult(null); setOcrText(null); setLearningConsent(false); if (photoInput.current) photoInput.current.value = ""; }}><X size={16} /></button></div>
          <button className="button button-secondary scan-button" type="button" disabled={reading || !rules} onClick={readPhoto}><ScanLine size={16} />{reading ? "Reading photo..." : "Read ticket photo"}</button></>}
        {ocrResult && <div className="ocr-review" role="status"><strong>{ocrResult.plays.length ? `${ocrResult.plays.length} suggested ${ocrResult.plays.length === 1 ? "play" : "plays"}` : "No complete plays detected"}</strong><p>{ocrResult.source === "remembered" ? "These plays were remembered from this exact photo. Check them against the ticket." : ocrResult.plays.length ? "Check every play against the photo. The reader can miss or misread numbers." : "Try a closer, sharper photo with the ticket flat and the numbers filling the frame, or enter the plays manually."}</p>{ocrResult.unrecognizedLines > 0 && <p>{ocrResult.unrecognizedLines} possible {ocrResult.unrecognizedLines === 1 ? "play needs" : "plays need"} manual entry.</p>}{ocrResult.plays.map((play, index) => <div className="ocr-play" key={index}>Play {index + 1}: {play.numbers.join(", ")} + {play.bonusNumber}</div>)}{ocrResult.plays.length > 0 && <button className="button button-secondary" type="button" onClick={() => { setPlays(ocrResult.plays.map((play) => ({ id: crypto.randomUUID(), numbersText: play.numbers.join(", "), bonusText: String(play.bonusNumber) }))); setOcrUnrecognized(ocrResult.unrecognizedLines); setOcrApplied(true); setOcrConfirmed(false); setLearningConsent(false); setActiveNumber(null); setOcrResult(null); }}>Replace plays with suggestions</button>}</div>}
        {ocrApplied && <div className="ocr-confirmation">{ocrUnrecognized > 0 && <p>{ocrUnrecognized} possible {ocrUnrecognized === 1 ? "play was" : "plays were"} not recognized. Add any missing plays before submitting.</p>}<label><input type="checkbox" checked={ocrConfirmed} onChange={(event) => setOcrConfirmed(event.target.checked)} />I checked every play against the ticket photo.</label></div>}
        {photo && <div className="ocr-learning"><label><input type="checkbox" checked={learningConsent} disabled={reading} onChange={(event) => setLearningConsent(event.target.checked)} />I checked these plays and agree to remember this photo on this browser.</label><p>The plays and a photo fingerprint are stored locally, not the photo or full scan text. They can be suggested for this exact photo; repeated OCR corrections may also help with other photos.</p>{ocrText !== null && !canLearn && <p>This scan has no OCR corrections, but its confirmed plays can still be remembered for this exact photo.</p>}</div>}
        {learningCount > 0 && <button className="text-button clear-learning-button" type="button" onClick={() => { const storage = readerStorage(); if (storage && clearOcrModel(storage, userId)) { setLearningCount(0); setOcrResult(null); setOcrText(null); setLearningConsent(false); setError(null); } else setError("Reader learning could not be cleared on this browser."); }}>Clear local reader learning</button>}
        </>}
        {editingContribution?.hasTicketPhoto && <p className="photo-help">The existing ticket photo will stay attached to this contribution.</p>}
        <div className="cost-preview"><span>Recorded ticket cost</span><strong>{selected?.ticketPrice != null ? ticketMoney(selected.ticketPrice * drawingCount * plays.length) : "Unavailable"}</strong><small>{loadingOptions ? "Loading drawings..." : !options.length ? "No drawings are available." : selected?.ticketPrice != null && rules ? "Based on saved official rules." : "Official rules and pricing are not available for this drawing."}</small></div>
        {needsPricingRefresh && <button className="button button-secondary refresh-price-button" type="button" disabled={refreshingPricing || loadingOptions} onClick={refreshPricing}>{refreshingPricing ? "Refreshing price..." : "Refresh official price"}</button>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || reading || (ocrApplied && !ocrConfirmed) || !selected || selected.ticketPrice === null || !rules}>{saving ? "Saving..." : editingContribution ? "Save changes" : <><Plus size={16} />Add ticket</>}</button></div>
        <p className="dialog-disclaimer"><ShieldCheck size={13} />Contributions are records only. No money is collected.</p>
      </form>
    </section>
  </div>;
}

export default App;
