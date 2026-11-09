CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE club_visibility AS ENUM ('public', 'private');
CREATE TYPE club_status AS ENUM ('active', 'closed');
CREATE TYPE membership_role AS ENUM ('creator', 'admin', 'member');
CREATE TYPE membership_status AS ENUM ('pending', 'active', 'removed');
CREATE TYPE payout_type AS ENUM (
  'equal_shares',
  'proportion_drawing_specific',
  'proportion_all_drawings'
);
CREATE TYPE threshold_method AS ENUM ('pooled', 'individual');
CREATE TYPE lottery_type AS ENUM ('powerball', 'mega_millions');
CREATE TYPE contribution_status AS ENUM ('draft', 'submitted', 'calculated', 'recalculated', 'archived');
CREATE TYPE drawing_status AS ENUM ('pending', 'results_posted', 'calculated', 'recalculated');
CREATE TYPE notification_channel AS ENUM ('in_app', 'email', 'push', 'sms');
CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'failed');
CREATE TYPE flag_status AS ENUM ('open', 'verified', 'escalated', 'resolved');
CREATE TYPE prize_award_status AS ENUM ('pending', 'allocated', 'recalculated');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  phone_number TEXT,
  is_phone_verified BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE clubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  motto TEXT,
  visibility club_visibility NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status club_status NOT NULL DEFAULT 'active',
  payout_configuration_id UUID,
  threshold_rule_id UUID,
  supported_lotteries lottery_type[] NOT NULL DEFAULT ARRAY[]::lottery_type[],
  allow_search BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE club_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'pending',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  removed_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (club_id, user_id)
);

CREATE TABLE payout_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL UNIQUE REFERENCES clubs(id) ON DELETE CASCADE,
  type payout_type NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE threshold_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL UNIQUE REFERENCES clubs(id) ON DELETE CASCADE,
  threshold_amount NUMERIC(12,2) NOT NULL CHECK (threshold_amount > 0),
  method threshold_method NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lottery lottery_type NOT NULL,
  drawing_date DATE NOT NULL,
  drawing_count INT NOT NULL CHECK (drawing_count >= 1),
  number_sets JSONB NOT NULL,
  ticket_image_url TEXT,
  cost_usd NUMERIC(12,2) NOT NULL CHECK (cost_usd > 0),
  status contribution_status NOT NULL DEFAULT 'submitted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE TABLE contribution_photos (
  contribution_id UUID PRIMARY KEY REFERENCES contributions(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data BYTEA NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 5242880),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE number_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  numbers JSONB NOT NULL,
  bonus_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE drawings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lottery lottery_type NOT NULL,
  drawing_date DATE NOT NULL,
  state TEXT NOT NULL,
  cutoff_time_et TIME NOT NULL,
  official_result_posted_at TIMESTAMPTZ,
  estimated_jackpot NUMERIC(18,2),
  cash_value NUMERIC(18,2),
  drawing_size_source_url TEXT,
  drawing_size_source_content_type TEXT,
  drawing_size_source_document TEXT,
  drawing_size_source_sha256 TEXT,
  drawing_size_captured_at TIMESTAMPTZ,
  status drawing_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lottery, drawing_date)
);

CREATE TABLE calculation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  lottery lottery_type NOT NULL,
  rules_url TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  price_snapshot JSONB NOT NULL,
  source_document_url TEXT,
  source_content_type TEXT,
  source_document TEXT,
  source_sha256 TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE drawing_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  official_winning_numbers JSONB,
  jackpot_estimate NUMERIC(18,2),
  prize_breakdown JSONB,
  official_source_url TEXT,
  official_source_content_type TEXT,
  official_source_document TEXT,
  official_source_sha256 TEXT,
  status drawing_status NOT NULL DEFAULT 'pending',
  calculation_started_at TIMESTAMPTZ,
  calculated_at TIMESTAMPTZ,
  source_snapshot_id UUID REFERENCES calculation_snapshots(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (drawing_id, club_id)
);

CREATE UNIQUE INDEX idx_calculation_snapshots_source_hash
  ON calculation_snapshots(drawing_id, club_id, source_sha256)
  WHERE source_sha256 IS NOT NULL;

CREATE TABLE prize_awards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_result_id UUID NOT NULL REFERENCES drawing_results(id) ON DELETE CASCADE,
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  prize_type TEXT NOT NULL,
  gross_prize_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  share_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  threshold_met BOOLEAN NOT NULL DEFAULT false,
  payout_type payout_type,
  status prize_award_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  in_app_enabled BOOLEAN NOT NULL DEFAULT true,
  email_enabled BOOLEAN NOT NULL DEFAULT true,
  push_enabled BOOLEAN NOT NULL DEFAULT false,
  sms_enabled BOOLEAN NOT NULL DEFAULT false,
  phone_verified BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  drawing_id UUID REFERENCES drawings(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  channel notification_channel NOT NULL,
  status notification_status NOT NULL DEFAULT 'queued',
  message TEXT NOT NULL,
  recalculation_type TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prize_award_id UUID NOT NULL REFERENCES prize_awards(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status flag_status NOT NULL DEFAULT 'open',
  escalated_to_support BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_clubs_owner_user_id ON clubs(owner_user_id);
CREATE INDEX idx_memberships_club_id ON club_memberships(club_id);
CREATE INDEX idx_memberships_user_id ON club_memberships(user_id);
CREATE INDEX idx_contributions_club_id ON contributions(club_id);
CREATE INDEX idx_contributions_user_id ON contributions(user_id);
CREATE INDEX idx_drawings_lottery_date ON drawings(lottery, drawing_date);
CREATE INDEX idx_drawing_results_club_id ON drawing_results(club_id);
CREATE INDEX idx_prize_awards_club_id ON prize_awards(club_id);
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_flags_club_id ON flags(club_id);
