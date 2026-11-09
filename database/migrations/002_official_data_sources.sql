ALTER TABLE calculation_snapshots
  ADD COLUMN source_document_url TEXT,
  ADD COLUMN source_content_type TEXT,
  ADD COLUMN source_document TEXT,
  ADD COLUMN source_sha256 TEXT;

ALTER TABLE drawing_results
  ADD COLUMN official_source_url TEXT,
  ADD COLUMN official_source_content_type TEXT,
  ADD COLUMN official_source_document TEXT,
  ADD COLUMN official_source_sha256 TEXT;

CREATE UNIQUE INDEX idx_calculation_snapshots_source_hash
  ON calculation_snapshots(drawing_id, club_id, source_sha256)
  WHERE source_sha256 IS NOT NULL;

CREATE UNIQUE INDEX idx_drawing_results_drawing_club
  ON drawing_results(drawing_id, club_id);
