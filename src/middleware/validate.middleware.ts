import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { sendError } from '../utils/response';

export const validateBody = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return sendError(res, 'Please check the submitted details and try again', 'VALIDATION_ERROR', result.error.format(), 400);
    }
    req.body = result.data;
    next();
  };
};

export const validateQuery = (schema: ZodSchema) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) return sendError(res, 'Invalid query parameters', 'VALIDATION_ERROR', result.error.format(), 400);

    // Express 5 exposes `req.query` as a getter-only accessor on the request
    // prototype, so `req.query = ...` throws
    // "Cannot set property query of # which has only a getter" on every VALID
    // request (a 500 instead of reaching the handler). Shadow it with an own
    // property so handlers still read the parsed/coerced values.
    Object.defineProperty(req, 'query', {
      value: result.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });

    next();
  };