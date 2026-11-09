ALTER TABLE drawings
  ADD COLUMN estimated_jackpot NUMERIC(18,2),
  ADD COLUMN cash_value NUMERIC(18,2),
  ADD COLUMN drawing_size_source_url TEXT,
  ADD COLUMN drawing_size_source_content_type TEXT,
  ADD COLUMN drawing_size_source_document TEXT,
  ADD COLUMN drawing_size_source_sha256 TEXT,
  ADD COLUMN drawing_size_captured_at TIMESTAMPTZ;