import type { DbLikeClient } from "./postgres-club-repository";

export interface NotificationEmail {
  to: string;
  subject: string;
  text: string;
}

export interface NotificationEmailSender {
  send(email: NotificationEmail): Promise<void>;
}

export interface NotificationEmailDeliverySummary {
  sent: number;
  failed: number;
  queued: number;
}

export class PostgresNotificationEmailDelivery {
  constructor(
    private readonly client: DbLikeClient,
    private readonly sender: NotificationEmailSender,
    private readonly maxAttempts = 5,
    private readonly batchSize = 10
  ) {}

  async deliverQueued(): Promise<NotificationEmailDeliverySummary> {
    if (!this.client.transaction) throw new Error("Notification delivery requires a transactional database client.");

    const claimed = await this.client.transaction(async (client) => {
      const { rows: disabledRows } = await client.query(
        `UPDATE notifications n
         SET status = 'failed', delivery_claimed_at = NULL,
             last_error = 'Email notifications disabled by recipient.'
         FROM notification_preferences p
         WHERE n.user_id = p.user_id AND n.channel = 'email' AND n.status = 'queued'
           AND NOT p.email_enabled
           AND (n.delivery_claimed_at IS NULL OR n.delivery_claimed_at < NOW() - INTERVAL '5 minutes')
         RETURNING n.id`,
      );
      const { rows: inactiveRows } = await client.query(
        `UPDATE notifications n
         SET status = 'failed', delivery_claimed_at = NULL,
             last_error = 'Recipient account is inactive.'
         FROM users u
         WHERE n.user_id = u.id AND n.channel = 'email' AND n.status = 'queued'
           AND u.status <> 'active'
           AND (n.delivery_claimed_at IS NULL OR n.delivery_claimed_at < NOW() - INTERVAL '5 minutes')
         RETURNING n.id`
      );
      const { rows: exhaustedRows } = await client.query(
        `UPDATE notifications
         SET status = 'failed', delivery_claimed_at = NULL,
             last_error = 'Maximum email delivery attempts reached.'
         WHERE channel = 'email' AND status = 'queued' AND delivery_attempts >= $1
           AND (delivery_claimed_at IS NULL OR delivery_claimed_at < NOW() - INTERVAL '5 minutes')
         RETURNING id`,
        [this.maxAttempts]
      );
      const { rows } = await client.query(
        `WITH candidates AS (
           SELECT n.id
           FROM notifications n
           JOIN users u ON u.id = n.user_id AND u.status = 'active'
           LEFT JOIN notification_preferences p ON p.user_id = n.user_id
           WHERE n.channel = 'email' AND n.status = 'queued'
             AND n.delivery_attempts < $1
             AND (n.delivery_claimed_at IS NULL OR n.delivery_claimed_at < NOW() - INTERVAL '5 minutes')
             AND COALESCE(p.email_enabled, true)
           ORDER BY n.created_at, n.id
           LIMIT $2 FOR UPDATE OF n SKIP LOCKED
         ), claimed AS (
           UPDATE notifications n
           SET delivery_claimed_at = NOW(), delivery_attempts = n.delivery_attempts + 1
           FROM candidates c
           WHERE n.id = c.id
           RETURNING n.id, n.user_id, n.message, n.delivery_attempts
         )
         SELECT claimed.id, claimed.user_id, claimed.message, claimed.delivery_attempts, u.email
         FROM claimed JOIN users u ON u.id = claimed.user_id`,
        [this.maxAttempts, this.batchSize]
      );
      return { rows, failed: disabledRows.length + inactiveRows.length + exhaustedRows.length };
    });
    let sent = 0;
    let failed = claimed.failed;
    let queued = 0;
    for (const row of claimed.rows) {
      try {
        await this.sender.send({
          to: row.email,
          subject: "The Club notification",
          text: row.message,
        });
        await this.client.query(
          `UPDATE notifications
           SET status = 'sent', sent_at = NOW(), delivery_claimed_at = NULL, last_error = NULL
           WHERE id = $1 AND status = 'queued'`,
          [row.id]
        );
        sent++;
      } catch (error) {
        const status = Number(row.delivery_attempts) >= this.maxAttempts ? "failed" : "queued";
        const failureCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : error instanceof Error ? error.name : "SMTPError";
        await this.client.query(
          `UPDATE notifications
           SET status = $2, delivery_claimed_at = NULL, last_error = $3
           WHERE id = $1 AND status = 'queued'`,
          [row.id, status, failureCode.slice(0, 100)]
        );
        if (status === "failed") failed++;
        else queued++;
      }
    }
    return { sent, failed, queued };
  }
}