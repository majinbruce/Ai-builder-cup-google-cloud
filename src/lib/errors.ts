/**
 * Operational errors are the ones we expect and can explain to the caller
 * (bad input, missing record, unauthorised). Anything else is a programmer
 * error and its message is never sent to the client in production.
 *
 * Same contract as the old ErrorHandler class — the only change is that
 * `isOperational` is now a readonly field TypeScript can actually check.
 */
import type { ErrorDetail } from "./api-response.ts";

export class AppError extends Error {
  override readonly name = "AppError";
  readonly statusCode: number;
  readonly isOperational = true;
  readonly details: ErrorDetail[] | null;

  constructor(message: string, statusCode = 500, details: ErrorDetail[] | null = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Narrowing helper — `err` in a Fastify error handler is typed as unknown-ish. */
export const isAppError = (err: unknown): err is AppError => err instanceof AppError;

export const badRequest = (message: string, details?: ErrorDetail[]): AppError =>
  new AppError(message, 400, details ?? null);

export const unauthorized = (message = "Unauthorized"): AppError =>
  new AppError(message, 401);

export const forbidden = (message = "Forbidden"): AppError => new AppError(message, 403);

export const notFound = (message = "Resource not found"): AppError =>
  new AppError(message, 404);

export const conflict = (message: string, details?: ErrorDetail[]): AppError =>
  new AppError(message, 409, details ?? null);
