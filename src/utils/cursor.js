import { AppError } from './app-error.js';

export function encodeCursor(link) {
  return Buffer.from(JSON.stringify({
    t: link.cursorTimestamp ?? new Date(link.createdAt).toISOString(), c: link.code,
  })).toString('base64url');
}
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!/^[a-zA-Z0-9_-]{4,32}$/.test(value.c) ||
        typeof value.t !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value.t) ||
        !Number.isFinite(Date.parse(value.t))) throw new Error();
    return { code: value.c, createdAt: value.t };
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
  }
}
