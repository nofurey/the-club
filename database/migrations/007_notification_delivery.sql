ALTER TABLE notifications
  ADD COLUMN read_at TIMESTAMPTZ,
  ADD COLUMN delivery_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN last_error TEXT;

CREATE INDEX idx_notifications_pending_email
  ON notifications(created_at)
  WHERE channel = 'email' AND status = 'queued';