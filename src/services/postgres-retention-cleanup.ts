import type { DbLikeClient } from "./postgres-club-repository";

export interface RetentionCleanupSummary {
  cutoffAt: string;
  calculationSourceBodies: number;
  resultSourceBodies: number;
  drawingSizeSourceBodies: number;
  closedClubs: number;
}

export class PostgresRetentionCleanup {
  constructor(private readonly client: DbLikeClient) {}

  async preview(): Promise<RetentionCleanupSummary> {
    return this.getSummary(this.client);
  }

  async apply(): Promise<RetentionCleanupSummary> {
    if (!this.client.transaction) {
      throw new Error("Retention cleanup requires a transactional database client.");
    }

    return this.client.transaction(async (client) => {
      const summary = await this.getSummary(client, true);
      const cutoffAt = summary.cutoffAt;
      const { rows: closedClubs } = await client.query(
        "SELECT id FROM clubs WHERE status = 'closed' AND closed_at < $1 FOR UPDATE",
        [cutoffAt]
      );

      await client.query(
        "UPDATE calculation_snapshots SET source_document = NULL WHERE captured_at < $1 AND source_document IS NOT NULL",
        [cutoffAt]
      );
      await client.query(
        "UPDATE drawing_results SET official_source_document = NULL WHERE COALESCE(official_source_captured_at, created_at) < $1 AND official_source_document IS NOT NULL",
        [cutoffAt]
      );
      await client.query(
        "UPDATE drawings SET drawing_size_source_document = NULL WHERE drawing_size_captured_at < $1 AND drawing_size_source_document IS NOT NULL",
        [cutoffAt]
      );

      const clubIds = closedClubs.map((row) => row.id);
      if (clubIds.length) {
        await client.query("DELETE FROM prize_awards WHERE club_id = ANY($1::uuid[])", [clubIds]);
        await client.query("DELETE FROM drawing_results WHERE club_id = ANY($1::uuid[])", [clubIds]);
        await client.query("DELETE FROM calculation_snapshots WHERE club_id = ANY($1::uuid[])", [clubIds]);
        await client.query("DELETE FROM clubs WHERE id = ANY($1::uuid[])", [clubIds]);
      }

      return summary;
    });
  }

  private async getSummary(client: DbLikeClient, lockClosedClubs = false): Promise<RetentionCleanupSummary> {
    const { rows: cutoffRows } = await client.query("SELECT NOW() - INTERVAL '12 months' AS cutoff_at");
    const cutoffAt = new Date(cutoffRows[0].cutoff_at).toISOString();
    const lockClause = lockClosedClubs ? " FOR UPDATE" : "";
    const calculationRows = await client.query(
      "SELECT COUNT(*)::int AS count FROM calculation_snapshots WHERE captured_at < $1 AND source_document IS NOT NULL",
      [cutoffAt]
    );
    const resultRows = await client.query(
      "SELECT COUNT(*)::int AS count FROM drawing_results WHERE COALESCE(official_source_captured_at, created_at) < $1 AND official_source_document IS NOT NULL",
      [cutoffAt]
    );
    const drawingRows = await client.query(
      "SELECT COUNT(*)::int AS count FROM drawings WHERE drawing_size_captured_at < $1 AND drawing_size_source_document IS NOT NULL",
      [cutoffAt]
    );
    const clubRows = await client.query(
      `SELECT id FROM clubs WHERE status = 'closed' AND closed_at < $1${lockClause}`,
      [cutoffAt]
    );

    return {
      cutoffAt,
      calculationSourceBodies: Number(calculationRows.rows[0]?.count ?? 0),
      resultSourceBodies: Number(resultRows.rows[0]?.count ?? 0),
      drawingSizeSourceBodies: Number(drawingRows.rows[0]?.count ?? 0),
      closedClubs: clubRows.rows.length,
    };
  }
}