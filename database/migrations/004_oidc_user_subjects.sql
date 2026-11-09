ALTER TABLE users
  ADD COLUMN auth_subject TEXT;

CREATE UNIQUE INDEX idx_users_auth_subject
  ON users(auth_subject)
  WHERE auth_subject IS NOT NULL;