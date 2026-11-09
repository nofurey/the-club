export class ClubApiError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code: string) {
    super(message);
  }
}
