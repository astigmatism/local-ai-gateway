import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { ApiError, isApiError } from '../errors/apiError.js';

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`, 'NOT_FOUND'));
};

const zodDetails = (error: ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message
  }));

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: zodDetails(error)
      }
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    const statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(statusCode).json({
      error: {
        code: error.code,
        message: error.code === 'LIMIT_FILE_SIZE' ? 'Uploaded audio file is too large.' : error.message
      }
    });
    return;
  }

  if (isApiError(error)) {
    const logContext = {
      path: req.originalUrl,
      method: req.method,
      statusCode: error.statusCode,
      code: error.code,
      errorName: error.name,
      errorMessage: error.message
    };

    if (error.statusCode >= 500) {
      logger.error({ ...logContext, stack: error.stack }, error.message);
    } else {
      logger.warn(logContext, error.message);
    }

    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.expose ? error.message : 'Internal server error.',
        details: error.details
      }
    });
    return;
  }

  logger.error({ err: error, path: req.originalUrl }, 'Unhandled server error');

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error.'
    }
  });
};
