export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly expose: boolean;

  constructor(statusCode: number, message: string, code = 'API_ERROR', details?: unknown, expose = true) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;
