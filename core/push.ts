// Web Push to installed web apps (iPhone home-screen apps, Android, desktop browsers). The key pair (VAPID)
// is made by this server on first start and kept in settings; no push relay or outside account is needed.
import type { Core } from './core.ts';
import { id, now, parse } from './util.ts';

export class Push {
  core: Core;
  publicKey = '';
  private privateKey = '';
  private wp: any = null;
  constructor(core: Core) { this.core = core; }

  get configured() { return !!this.publicKey; }

  async start() {
    try {
      this.wp = (await import('web-push')).default;
      let keys = parse<any>((await this.core.db.get<any>("SELECT value FROM settings WHERE scope = 'server' AND key = 'vapid'"))?.value, null);
      if (this.core.env.VAPID_PUBLIC_KEY && this.core.env.VAPID_PRIVATE_KEY) keys = { publicKey: this.core.env.VAPID_PUBLIC_KEY, privateKey: this.core.env.VAPID_PRIVATE_KEY };
      if (!keys) {
        keys = this.wp.generateVAPIDKeys();
        await this.core.db.run("INSERT INTO settings (scope, key, value, updated_at) VALUES ('server', 'vapid', ?, ?)", [JSON.stringify(keys), now()]);
      }
      this.publicKey = keys.publicKey;
      this.privateKey = keys.privateKey;
      const subject = this.core.env.VAPID_SUBJECT || `mailto:${/<([^>]+)>/.exec(this.core.mail.from)?.[1] ?? 'wos@example.com'}`;
      this.wp.setVapidDetails(subject.includes('localhost') ? 'mailto:wos@example.com' : subject, this.publicKey, this.privateKey);
    } catch (e: any) {
      this.core.log.warn(`Web Push is off: ${e.message}`);
    }
  }

  async subscribe(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device?: string) {
    await this.core.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
    await this.core.db.run('INSERT INTO push_subscriptions (id, user_id, endpoint, keys, device, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id('push'), userId, sub.endpoint, JSON.stringify(sub.keys), device ?? null, now()]);
  }

  async unsubscribe(userId: string, endpoint?: string) {
    const r = endpoint ? await this.core.db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, endpoint]) : await this.core.db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
    return r.changes;
  }

  /** Send to every device the person installed. Dead subscriptions are removed. */
  async send(userId: string, payload: { title: string; body?: string; url?: string; tag?: string; actions?: { action: string; title: string }[] }) {
    if (!this.configured) return 0;
    const subs = await this.core.db.query<any>('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
    let sent = 0;
    for (const s of subs) {
      try {
        await this.wp.sendNotification({ endpoint: s.endpoint, keys: parse(s.keys, {}) }, JSON.stringify(payload), { TTL: 3600 });
        sent++;
      } catch (e: any) {
        if (e.statusCode === 404 || e.statusCode === 410) await this.core.db.run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
        else this.core.log.warn(`push failed: ${e.message}`);
      }
    }
    return sent;
  }
}
