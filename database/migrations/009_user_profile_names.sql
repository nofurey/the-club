ALTER TABLE users
  ADD COLUMN username TEXT,
  ADD COLUMN first_name TEXT,
  ADD COLUMN last_name TEXT;

ALTER TABLE users
  ADD CONSTRAINT users_username_format
    CHECK (username IS NULL OR username ~ '^[A-Za-z0-9._-]{3,30}$'),
  ADD CONSTRAINT users_first_name_not_blank
    CHECK (first_name IS NULL OR length(trim(first_name)) > 0),
  ADD CONSTRAINT users_last_name_not_blank
    CHECK (last_name IS NULL OR length(trim(last_name)) > 0);

CREATE UNIQUE INDEX idx_users_username_lower
  ON users (lower(username))
  WHERE username IS NOT NULL;