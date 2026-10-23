import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { store } from '../store/memoryStore';
import { config } from '../config';

export interface AuthedRequest extends Request {
  userId?: string;
  role?: string;
}

export function signToken(userId: string, role: string): string {
  return jwt.sign({ sub: userId, role }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
}

/** Verifies the Bearer JWT and attaches userId/role to the request. */
export function authenticate(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), config.jwt.secret) as jwt.JwtPayload;
    // A valid signature is not enough: the account must still exist. A
    // deleted user's unexpired token would otherwise keep full access.
    if (!store.users.get(payload.sub as string)) {
      res.status(401).json({ error: 'This account no longer exists' });
      return;
    }
    req.userId = payload.sub as string;
    req.role = payload.role as string;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
