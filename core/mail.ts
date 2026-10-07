// Outgoing mail: sign-in links, invites, alerts and digests. SMTP_URL (any mailbox works, for example
// smtps://you%40example.com:app-password@smtp.example.com:465) and MAIL_FROM. Without SMTP, mail is recorded
// in the outbox table and printed in the server log, so a self-hoster can still finish signing in.
import type { Core } from './core.ts';
import { id, now } from './util.ts';

export class Mailer {
  core: Core;
  private transport: any = null;
  constructor(core: Core) { this.core = core; }

  get configured() { return !!this.core.env.SMTP_URL; }
  get from() { return this.core.env.MAIL_FROM || 'wOS <wos@localhost>'; }

  async send(m: { teamId?: string | null; to: string; subject: string; text: string }) {
    const row = { id: id('mail'), status: 'logged', error: null as string | null };
    if (this.configured) {
      try {
        if (!this.transport) {
          const nodemailer = (await import('nodemailer')).default;
          this.transport = nodemailer.createTransport(this.core.env.SMTP_URL);
        }
        await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
        row.status = 'sent';
      } catch (e: any) {
        row.status = 'failed';
        row.error = e.message;
        this.core.log.warn(`mail to ${m.to} failed: ${e.message}`);
      }
    } else {
      this.core.log.info(`mail (SMTP_URL not set, not sent) to ${m.to}: ${m.subject}\n${m.text}`);
    }
    await this.core.db.run('INSERT INTO outbox (id, team_id, to_addr, subject, body, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [row.id, m.teamId ?? null, m.to, m.subject, m.text, row.status, row.error, now()]).catch(() => {});
    return { sent: row.status === 'sent', id: row.id, status: row.status };
  }
}
