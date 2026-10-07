import crypto from 'node:crypto';

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '').slice(0, 10).toLowerCase() || crypto.randomUUID().slice(0, 8)}`;
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');
export const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

export function parse<T = any>(s: unknown, fallback: T): T {
  if (s == null || s === '') return fallback;
  if (typeof s !== 'string') return s as T;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** An error with a code the API returns and a plain message a person can act on. */
export class WosError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const fail = (code: string, message: string, status = 400): never => { throw new WosError(code, message, status); };

export const slugify = (s: string) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
