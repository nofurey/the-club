CREATE TABLE contribution_photos (
  contribution_id UUID PRIMARY KEY REFERENCES contributions(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data BYTEA NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 5242880),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);