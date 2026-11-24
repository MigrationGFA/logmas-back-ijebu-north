import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response';
const env = require('../config/env');

/**
 * Raw library and database errors carry text meant for a server log,
 * not a person's screen (multi-line invocation dumps, generated code
 * fragments). Anything that looks like that is replaced with a plain
 * sentence before the response leaves; the real error is still logged
 * in full above. Errors raised deliberately with their own status code
 * and a clean message pass through untouched.
 */
const looksTechnical = (message: string): boolean =>
  message.length > 200 ||
  message.includes('\n') ||
  message.includes('`') ||
  /prisma|invocation|node_modules/i.test(message);

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('🔥 Centralized Error Captured:', err.message || err);

  const statusCode = err.statusCode || 500;
  // Prisma error codes (P2002 and friends) are database internals; they
  // are not the API's own error vocabulary and must not leak as the
  // response code.
  const code =
    typeof err.code === 'string' && /^P\d{4}$/.test(err.code)
      ? 'DATABASE_ERROR'
      : err.code || 'INTERNAL_SERVER_ERROR';
  let message = err.message || 'An unexpected operational breakdown occurred.';
  if (statusCode >= 500 && looksTechnical(message)) {
    message = 'An unexpected error occurred on our side. Please try again.';
  }
  const details = env.NODE_ENV === 'development' ? err.stack : null;

  return sendError(res, message, code, details, statusCode);
};
