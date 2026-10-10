import type { ErrorRequestHandler } from 'express';
import { safeErrorMeta } from '@idp/shared';
import { AppError } from '../../common/AppError';

export const coreErrorHandler: ErrorRequestHandler = (err: Error, _req, res, _next) => {
  const isAppError = err instanceof AppError;
  const status = isAppError ? err.status : 500;
  const payload: Record<string, unknown> = {
    error: err.message,
    ...(isAppError && err.code ? { code: err.code } : {}),
  };
  if (process.env.NODE_ENV !== 'production') payload.stack = err.stack;
  else if (status >= 500) payload.error = 'Internal server error';
  if (!isAppError) console.error('Unhandled error:', safeErrorMeta(err));
  return res.status(status).json(payload);
};
