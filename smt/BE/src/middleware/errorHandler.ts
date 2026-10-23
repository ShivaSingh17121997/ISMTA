import { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
}
