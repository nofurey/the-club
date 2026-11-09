import type { DbLikeClient } from "./postgres-club-repository";

export function wrapPgLikeClient(
  client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }
): DbLikeClient {
  return {
    query: async (text: string, params: any[] = []) => client.query(text, params),
  };
}

export function createPostgresClubRepositoryFromClient(client: {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}) {
  const { PostgresClubRepository } = require("./postgres-club-repository");
  return new PostgresClubRepository(wrapPgLikeClient(client));
}
