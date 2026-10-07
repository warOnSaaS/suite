// The server key: signs short-lived links and seals secrets (model API keys) at rest.
// It comes from WOS_SECRET_KEY, or is generated once into the data folder. It never goes into the database,
// so a stolen database dump does not reveal anyone's API keys.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let key: Buffer | null = null;

export function initKey(env: NodeJS.ProcessEnv, dataDir: string) {
  if (env.WOS_SECRET_KEY) {
    key = crypto.createHash('sha256').update(`wos:${env.WOS_SECRET_KEY}`).digest();
    return 'from WOS_SECRET_KEY';
  }
  const file = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  key = crypto.createHash('sha256').update(`wos:${fs.readFileSync(file, 'utf8').trim()}`).digest();
  return `from ${file}`;
}

const k = (purpose: string) => {
  if (!key) throw new Error('Server key not set up');
  return crypto.createHmac('sha256', key).update(purpose).digest();
};

/** AES-256-GCM. Output is base64url(iv | tag | ciphertext). */
export function seal(value: unknown, purpose = 'seal'): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k(purpose), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function unseal<T = unknown>(text: string | null | undefined, purpose = 'seal'): T | null {
  try {
    const raw = Buffer.from(String(text ?? ''), 'base64url');
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', k(purpose), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

/** Signed, expiring, stateless tokens for links and OAuth steps: base64url(json).mac */
export function sign(payload: Record<string, unknown>, ttlSeconds: number) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', k('sign')).update(body).digest('base64url')}`;
}

export function verify<T extends Record<string, unknown> = Record<string, unknown>>(tok: unknown, kind: string): T | null {
  const [body, mac] = String(tok ?? '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', k('sign')).update(body).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.k !== kind || (p.exp && p.exp < Date.now() / 1000)) return null;
    return p;
  } catch {
    return null;
  }
}
