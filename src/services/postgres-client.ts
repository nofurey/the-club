import type { DbLikeClient } from "./postgres-club-repository";

type PgLikeClient = {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
  connect?: () => Promise<{
    query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
    release?: () => void;
  }>;
};

export function wrapPgLikeClient(client: PgLikeClient): DbLikeClient {
  const wrapped: DbLikeClient = {
    query: async (text: string, params: any[] = []) => client.query(text, params),
  };
  if (client.connect) {
    wrapped.transaction = async <T>(operation: (transactionClient: DbLikeClient) => Promise<T>): Promise<T> => {
      const connection = await client.connect!();
      try {
        await connection.query("BEGIN");
        const result = await operation(wrapPgLikeClient(connection));
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release?.();
      }
    };
  }
  return wrapped;
}

export function createPostgresClubRepositoryFromClient(client: {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}) {
  const { PostgresClubRepository } = require("./postgres-club-repository");
  return new PostgresClubRepository(wrapPgLikeClient(client));
}
