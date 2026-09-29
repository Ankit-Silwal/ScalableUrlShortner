import { z } from 'zod';

export const codeSchema = z.string().regex(/^[a-zA-Z0-9_-]{4,32}$/, 'Code must contain 4–32 letters, digits, underscores, or hyphens');
const reserved = new Set(['api', 'health', 'ready', 'favicon', 'robots', 'metrics']);
const urlSchema = z.string().trim().max(2048).url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Use an HTTP(S) URL without embedded credentials');

export const createLinkSchema = z.object({
  originalUrl: urlSchema,
  customAlias: codeSchema.refine((code) => !reserved.has(code.toLowerCase()), 'Alias is reserved').optional(),
  expiresAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value))
    .refine((value) => value.getTime() > Date.now(), 'Expiry must be in the future').optional(),
}).strict();
export const codeParamsSchema = z.object({ code: codeSchema });
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1).optional(),
  cursor: z.string().max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
