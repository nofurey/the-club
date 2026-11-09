BEGIN;

INSERT INTO users (id, email, display_name, status)
VALUES
  ('e1000000-0000-4000-8000-000000000001', 'refresh-demo-owner@example.invalid', 'Official Refresh Demo Owner', 'active'),
  ('e1000000-0000-4000-8000-000000000002', 'refresh-demo-member@example.invalid', 'Official Refresh Demo Member', 'active')
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    status = EXCLUDED.status;

INSERT INTO clubs (
  id, name, description, visibility, owner_user_id, status,
  payout_configuration_id, threshold_rule_id, supported_lotteries, allow_search
)
VALUES (
  'e1000000-0000-4000-8000-000000000003',
  'Official Refresh Demo Club',
  'Local sample club for exercising the official-data refresh worker.',
  'public',
  'e1000000-0000-4000-8000-000000000001',
  'active',
  'e1000000-0000-4000-8000-000000000004',
  'e1000000-0000-4000-8000-000000000005',
  ARRAY['powerball', 'mega_millions']::lottery_type[],
  true
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    visibility = EXCLUDED.visibility,
    owner_user_id = EXCLUDED.owner_user_id,
    status = EXCLUDED.status,
    payout_configuration_id = EXCLUDED.payout_configuration_id,
    threshold_rule_id = EXCLUDED.threshold_rule_id,
    supported_lotteries = EXCLUDED.supported_lotteries,
    allow_search = EXCLUDED.allow_search,
    updated_at = NOW();

INSERT INTO payout_configurations (id, club_id, type, version)
VALUES (
  'e1000000-0000-4000-8000-000000000004',
  'e1000000-0000-4000-8000-000000000003',
  'equal_shares',
  1
)
ON CONFLICT (club_id) DO UPDATE
SET type = EXCLUDED.type,
    version = EXCLUDED.version;

INSERT INTO threshold_rules (id, club_id, threshold_amount, method)
VALUES (
  'e1000000-0000-4000-8000-000000000005',
  'e1000000-0000-4000-8000-000000000003',
  100,
  'pooled'
)
ON CONFLICT (club_id) DO UPDATE
SET threshold_amount = EXCLUDED.threshold_amount,
    method = EXCLUDED.method;

UPDATE clubs
SET payout_configuration_id = 'e1000000-0000-4000-8000-000000000004',
    threshold_rule_id = 'e1000000-0000-4000-8000-000000000005',
    supported_lotteries = ARRAY['powerball', 'mega_millions']::lottery_type[],
    updated_at = NOW()
WHERE id = 'e1000000-0000-4000-8000-000000000003';

INSERT INTO club_memberships (
  id, club_id, user_id, role, status, joined_at, approved_at
)
VALUES
  (
    'e1000000-0000-4000-8000-000000000006',
    'e1000000-0000-4000-8000-000000000003',
    'e1000000-0000-4000-8000-000000000001',
    'creator', 'active', NOW(), NOW()
  ),
  (
    'e1000000-0000-4000-8000-000000000007',
    'e1000000-0000-4000-8000-000000000003',
    'e1000000-0000-4000-8000-000000000002',
    'member', 'active', NOW(), NOW()
  )
ON CONFLICT (club_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    status = EXCLUDED.status,
    approved_at = COALESCE(club_memberships.approved_at, EXCLUDED.approved_at),
    updated_at = NOW();

CREATE TEMP TABLE official_refresh_demo_schedule AS
WITH today AS (
  SELECT timezone('America/New_York', NOW())::date AS drawing_date
),
candidate_drawings AS (
  SELECT
    'powerball'::lottery_type AS lottery,
    schedule_day.drawing_at::date AS drawing_date,
    TIME '21:58:00' AS cutoff_time_et
  FROM today
  CROSS JOIN LATERAL generate_series(
    today.drawing_date::timestamp,
    (today.drawing_date + 21)::timestamp,
    INTERVAL '1 day'
  ) AS schedule_day(drawing_at)
  WHERE EXTRACT(ISODOW FROM schedule_day.drawing_at) IN (1, 3, 6)

  UNION ALL

  SELECT
    'mega_millions'::lottery_type AS lottery,
    schedule_day.drawing_at::date AS drawing_date,
    TIME '22:45:00' AS cutoff_time_et
  FROM today
  CROSS JOIN LATERAL generate_series(
    today.drawing_date::timestamp,
    (today.drawing_date + 21)::timestamp,
    INTERVAL '1 day'
  ) AS schedule_day(drawing_at)
  WHERE EXTRACT(ISODOW FROM schedule_day.drawing_at) IN (2, 5)
),
ranked_drawings AS (
  SELECT
    lottery,
    drawing_date,
    cutoff_time_et,
    ROW_NUMBER() OVER (PARTITION BY lottery ORDER BY drawing_date) AS schedule_index
  FROM candidate_drawings
)
SELECT lottery, drawing_date, cutoff_time_et
FROM ranked_drawings
WHERE schedule_index <= 2;

INSERT INTO drawings (lottery, drawing_date, state, cutoff_time_et, status)
SELECT lottery, drawing_date, 'MI', cutoff_time_et, 'pending'
FROM official_refresh_demo_schedule
ON CONFLICT (lottery, drawing_date) DO NOTHING;

WITH first_draws AS (
  SELECT DISTINCT ON (lottery) lottery, drawing_date
  FROM official_refresh_demo_schedule
  ORDER BY lottery, drawing_date
)
INSERT INTO contributions (
  id, club_id, user_id, lottery, drawing_date, drawing_count, number_sets, cost_usd, status
)
SELECT
  CASE lottery
    WHEN 'powerball'::lottery_type THEN 'e1000000-0000-4000-8000-000000000008'::uuid
    ELSE 'e1000000-0000-4000-8000-000000000009'::uuid
  END,
  'e1000000-0000-4000-8000-000000000003'::uuid,
  'e1000000-0000-4000-8000-000000000002'::uuid,
  lottery,
  drawing_date,
  2,
  CASE lottery
    WHEN 'powerball'::lottery_type THEN jsonb_build_array(
      jsonb_build_object('numbers', jsonb_build_array(7, 14, 21, 28, 35), 'bonusNumber', '9')
    )
    ELSE jsonb_build_array(
      jsonb_build_object('numbers', jsonb_build_array(8, 19, 30, 41, 52), 'bonusNumber', '6')
    )
  END,
  CASE lottery WHEN 'powerball'::lottery_type THEN 4.00 ELSE 10.00 END,
  'submitted'
FROM first_draws
ON CONFLICT (id) DO UPDATE
SET club_id = EXCLUDED.club_id,
    user_id = EXCLUDED.user_id,
    lottery = EXCLUDED.lottery,
    drawing_date = EXCLUDED.drawing_date,
    drawing_count = EXCLUDED.drawing_count,
    number_sets = EXCLUDED.number_sets,
    cost_usd = EXCLUDED.cost_usd,
    status = EXCLUDED.status,
    updated_at = NOW();

COMMIT;