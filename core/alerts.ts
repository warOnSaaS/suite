// The one inbox. Agents (and apps) raise alerts: approvals, questions, blocked, done, failed. Each goes to
// the person's inbox, and out on the channels their rules pick: a browser notification while wOS is open,
// Web Push to their installed devices, and email (at once, or after some minutes unanswered).
import type { Core } from './core.ts';
import type { CoreTool } from './types.ts';
import { id, now, parse, fail } from './util.ts';
import { sign } from './crypto.ts';

export type AlertKind = 'approval' | 'question' | 'blocked' | 'done' | 'failed';
export interface ChannelRule { desktop: boolean; push: boolean; email: boolean; email_after_min: number }
export interface Rules { kinds: Record<AlertKind, ChannelRule>; quiet_hours: { from: string; to: string } | null }

// Approved defaults (ROADMAP 8.2 step 3): approvals and failures go everywhere; done goes to the inbox only.
export const DEFAULT_RULES: Rules = {
  kinds: {
    approval: { desktop: true, push: true, email: true, email_after_min: 10 },
    question: { desktop: true, push: true, email: true, email_after_min: 30 },
    blocked: { desktop: true, push: true, email: false, email_after_min: 0 },
    failed: { desktop: true, push: true, email: true, email_after_min: 0 },
    done: { desktop: false, push: false, email: false, email_after_min: 0 },
  },
  quiet_hours: null,
};

export class Alerts {
  core: Core;
  constructor(core: Core) { this.core = core; }

  async rules(teamId: string, personId: string): Promise<Rules> {
    const r = await this.core.db.get<any>('SELECT rules FROM alert_rules WHERE team_id = ? AND person_id = ?', [teamId, personId]);
    const saved = parse<Partial<Rules>>(r?.rules, {});
    return { kinds: { ...DEFAULT_RULES.kinds, ...(saved.kinds ?? {}) }, quiet_hours: saved.quiet_hours ?? null };
  }

  async raise(a: { teamId: string; personId: string; kind: AlertKind; title: string; body?: string; options?: string[]; ref?: unknown; source?: string }) {
    const alert = { id: id('al'), team_id: a.teamId, person_id: a.personId, kind: a.kind, title: a.title.slice(0, 200), body: a.body ?? null, options: (a.options ?? []).slice(0, 3), ref: a.ref ?? null, source: a.source ?? null, status: 'open', created_at: now() };
    await this.core.db.run('INSERT INTO alerts (id, team_id, person_id, kind, title, body, options, ref, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      alert.id, alert.team_id, alert.person_id, alert.kind, alert.title, alert.body, JSON.stringify(alert.options), JSON.stringify(alert.ref), alert.source, 'open', alert.created_at,
    ]);
    const rules = await this.rules(a.teamId, a.personId);
    const rule = rules.kinds[a.kind] ?? DEFAULT_RULES.kinds.question;
    const quiet = inQuietHours(rules.quiet_hours);
    this.core.events.publish(a.teamId, 'alerts.alert.raised', { ...alert, notify: rule.desktop && !quiet }, undefined, a.personId);
    if (rule.push && !quiet) {
      const n = await this.core.push.send(a.personId, { title: alert.title, body: alert.body?.slice(0, 180) ?? '', url: `/inbox?alert=${alert.id}`, tag: alert.id, actions: alert.options.slice(0, 2).map((o, i) => ({ action: String(i), title: o })) }).catch(() => 0);
      if (n) await this.core.db.run('UPDATE alerts SET pushed_at = ? WHERE id = ?', [now(), alert.id]);
    }
    if (rule.email && rule.email_after_min === 0 && !quiet) await this.email(alert.id);
    return alert;
  }

  /** Email an alert, with one signed link per answer. Links open a confirm page; a bare click never acts. */
  async email(alertId: string) {
    const a = await this.core.db.get<any>('SELECT * FROM alerts WHERE id = ?', [alertId]);
    if (!a || a.status !== 'open' || a.emailed_at) return;
    const u = await this.core.users.get(a.person_id);
    if (!u?.email) return;
    const opts = parse<string[]>(a.options, []);
    const link = (i: number | null) => `${this.core.publicUrl}/alerts/answer?t=${encodeURIComponent(sign({ k: 'answer', a: a.id, o: i, u: a.person_id }, 7 * 86400))}`;
    // When the Email app is on for this team and offers a transport, alerts go out through it (threaded, with
    // reply tokens it reads back with ctx.alerts.answer). Otherwise the core sends plain mail with signed links.
    const transport = (await this.core.registry.isOn(a.team_id, 'email')) ? (this.core.registry.apps.get('email')?.server as any)?.alertTransport : null;
    if (transport?.send) {
      try {
        await transport.send({ alertId: a.id, teamId: a.team_id, personId: a.person_id, to: u.email, title: a.title, body: a.body ?? '', options: opts, kind: a.kind, link: `${this.core.publicUrl}/inbox?alert=${a.id}`, answerLinks: opts.map((_, i) => link(i)) });
        await this.core.db.run('UPDATE alerts SET emailed_at = ? WHERE id = ?', [now(), a.id]);
        return;
      } catch (e: any) {
        this.core.log.warn(`Email app could not send alert ${a.id}: ${e.message}; using plain mail`);
      }
    }
    const lines = [a.body ?? '', '', ...opts.map((o, i) => `${o}: ${link(i)}`), opts.length ? '' : `Open: ${this.core.publicUrl}/inbox?alert=${a.id}`, '', 'Each link asks you to confirm before anything happens.'];
    await this.core.mail.send({ teamId: a.team_id, to: u.email, subject: `[wOS] ${a.title}`, text: lines.join('\n').trim() });
    await this.core.db.run('UPDATE alerts SET emailed_at = ? WHERE id = ?', [now(), a.id]);
  }

  /** Once a minute: email open alerts that waited longer than the person's rule allows. */
  startEscalation() {
    this.core.every(60_000, () => this.escalate());
  }

  async escalate() {
    const open = await this.core.db.query<any>("SELECT id, team_id, person_id, kind, created_at FROM alerts WHERE status = 'open' AND emailed_at IS NULL AND created_at < ?", [new Date(Date.now() - 60_000).toISOString()]);
    for (const a of open) {
      const rule = (await this.rules(a.team_id, a.person_id)).kinds[a.kind as AlertKind];
      if (rule?.email && Date.parse(a.created_at) + rule.email_after_min * 60_000 <= Date.now()) await this.email(a.id);
    }
  }

  async answer(alertId: string, personId: string, answer: string | number, via: string) {
    const a = await this.core.db.get<any>('SELECT * FROM alerts WHERE id = ?', [alertId]);
    if (!a || a.person_id !== personId) fail('not_found', 'No such alert in your inbox.', 404);
    if (a.status !== 'open') return { id: a.id, status: a.status, answer: a.answer, already: true };
    const opts = parse<string[]>(a.options, []);
    const text = typeof answer === 'number' ? opts[answer] : String(answer);
    if (text === undefined) fail('invalid_input', `Pick one of: ${opts.map((o, i) => `${i + 1} ${o}`).join(', ')}.`);
    await this.core.db.run("UPDATE alerts SET status = 'answered', answer = ?, answered_via = ?, answered_at = ? WHERE id = ?", [text, via, now(), alertId]);
    const ref = parse<any>(a.ref, null);
    let outcome: unknown = null;
    if (ref?.approval_id) outcome = await this.core.catalogue.decideApproval(ref.approval_id, /^(approve|yes|ok|1)$/i.test(text.trim()), personId);
    this.core.events.publish(a.team_id, 'alerts.alert.answered', { id: alertId, answer: text, ref, kind: a.kind, via });
    return { id: alertId, status: 'answered', answer: text, outcome };
  }
}

function inQuietHours(q: Rules['quiet_hours']) {
  if (!q) return false;
  const hm = new Date().toISOString().slice(11, 16);
  return q.from <= q.to ? hm >= q.from && hm < q.to : hm >= q.from || hm < q.to;
}

const S = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object' as const, properties: props, required, additionalProperties: false });
const view = (r: any) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, options: parse(r.options, []), ref: parse(r.ref, null), source: r.source, status: r.status, answer: r.answer, answered_via: r.answered_via, created_at: r.created_at, answered_at: r.answered_at });
const ruleSchema = { type: 'object', properties: { desktop: { type: 'boolean' }, push: { type: 'boolean' }, email: { type: 'boolean' }, email_after_min: { type: 'integer', minimum: 0, maximum: 1440 } } };

export function alertTools(core: Core): CoreTool[] {
  return [
    {
      spec: { name: 'alerts.list', title: 'Open inbox', description: 'Your inbox: questions, approvals and notices from agents and apps, newest first. status open (default), answered, cleared or all.', input: S({ status: { enum: ['open', 'answered', 'cleared', 'all'], default: 'open' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }), scope: 'read', confirm: 'none', test: 'test/unit/alerts.test.ts' },
      handler: async ({ status, limit }, call: any) => {
        const rows = await core.db.query<any>(`SELECT * FROM alerts WHERE team_id = ? AND person_id = ? ${status === 'all' ? '' : 'AND status = ?'} ORDER BY created_at DESC LIMIT ?`, status === 'all' ? [call.team.id, call.caller.user.id, limit] : [call.team.id, call.caller.user.id, status, limit]);
        const open = await core.db.get<any>("SELECT COUNT(*) AS n FROM alerts WHERE team_id = ? AND person_id = ? AND status = 'open'", [call.team.id, call.caller.user.id]);
        return { open: Number(open?.n ?? 0), alerts: rows.map(view) };
      },
    },
    {
      spec: { name: 'alerts.answer', title: 'Answer', description: 'Answer an alert: pick an option by number (0 is the first; the inbox keys 1, 2 and 3 send 0, 1 and 2) or send your own words. Approving runs the waiting action; the agent then carries on.', input: S({ alert_id: { type: 'string' }, option: { type: 'integer', minimum: 0, maximum: 2 }, text: { type: 'string', maxLength: 4000 } }, ['alert_id']), scope: 'write', confirm: 'none', emits: ['alerts.alert.answered'], test: 'test/unit/alerts.test.ts' },
      handler: async ({ alert_id, option, text }, call: any) => {
        if (option === undefined && !text) fail('invalid_input', 'Pick an option or write an answer.');
        if (call.actor.kind === 'agent') fail('person_only', 'Only the person can answer their own alerts.', 403);
        return core.alerts.answer(alert_id, call.caller.user.id, option ?? text, call.via);
      },
    },
    {
      spec: { name: 'alerts.clear', title: 'Clear', description: 'Clear an alert from the inbox without answering (the E key). Questions stay unanswered; the agent keeps waiting or carries on without.', input: S({ alert_id: { type: 'string' } }, ['alert_id']), scope: 'write', confirm: 'none', test: 'test/unit/alerts.test.ts' },
      handler: async ({ alert_id }, call: any) => {
        const r = await core.db.run("UPDATE alerts SET status = 'cleared', answered_at = ? WHERE id = ? AND person_id = ? AND status = 'open'", [now(), alert_id, call.caller.user.id]);
        call.emit('alerts.alert.cleared', { id: alert_id });
        return { cleared: r.changes > 0 };
      },
    },
    {
      spec: { name: 'alerts.get_rules', title: 'Alert settings', description: 'Which kinds of alert reach you where: browser notification, phone push, email (and after how many minutes unanswered), plus quiet hours.', input: S(), scope: 'read', confirm: 'none', test: 'test/unit/alerts.test.ts' },
      handler: async (_i, call: any) => ({ ...(await core.alerts.rules(call.team.id, call.caller.user.id)), push_devices: Number((await core.db.get<any>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [call.caller.user.id]))?.n ?? 0), email: call.caller.user.email, email_ready: core.mail.configured }),
    },
    {
      spec: { name: 'alerts.set_rules', title: 'Change alert settings', description: 'Choose per kind (approval, question, blocked, failed, done) whether it notifies in the browser, pushes to your phone, or emails you, and quiet hours in UTC (HH:MM).', input: S({ kinds: { type: 'object', properties: { approval: ruleSchema, question: ruleSchema, blocked: ruleSchema, failed: ruleSchema, done: ruleSchema } }, quiet_hours: { anyOf: [{ type: 'null' }, { type: 'object', properties: { from: { type: 'string', pattern: '^\\d\\d:\\d\\d$' }, to: { type: 'string', pattern: '^\\d\\d:\\d\\d$' } }, required: ['from', 'to'] }] } }), scope: 'write', confirm: 'none', test: 'test/unit/alerts.test.ts' },
      handler: async ({ kinds, quiet_hours }, call: any) => {
        const cur = await core.alerts.rules(call.team.id, call.caller.user.id);
        const merged: Rules = { kinds: { ...cur.kinds }, quiet_hours: quiet_hours === undefined ? cur.quiet_hours : quiet_hours };
        for (const [k, v] of Object.entries<any>(kinds ?? {})) (merged.kinds as any)[k] = { ...(merged.kinds as any)[k], ...v };
        await core.db.run('DELETE FROM alert_rules WHERE team_id = ? AND person_id = ?', [call.team.id, call.caller.user.id]);
        await core.db.run('INSERT INTO alert_rules (team_id, person_id, rules, updated_at) VALUES (?, ?, ?, ?)', [call.team.id, call.caller.user.id, JSON.stringify(merged), now()]);
        return merged;
      },
    },
    {
      spec: { name: 'alerts.push_key', title: 'Push key', description: "This server's public Web Push key, which a browser needs to subscribe this device to alerts.", input: S(), scope: 'read', confirm: 'none', hidden: true, test: 'test/unit/alerts.test.ts' },
      handler: async () => ({ public_key: core.push.publicKey || null }),
    },
    {
      spec: { name: 'alerts.subscribe_push', title: 'Turn on phone alerts', description: "Send this device's alerts by Web Push. The browser must ask the person first; an agent can only remind them to press the button.", input: S({ endpoint: { type: 'string' }, keys: { type: 'object', properties: { p256dh: { type: 'string' }, auth: { type: 'string' } }, required: ['p256dh', 'auth'] }, device: { type: 'string', maxLength: 80 } }, ['endpoint', 'keys']), scope: 'write', confirm: 'none', hidden: true, test: 'test/unit/alerts.test.ts' },
      handler: async ({ endpoint, keys, device }, call: any) => { await core.push.subscribe(call.caller.user.id, { endpoint, keys }, device); return { subscribed: true }; },
    },
    {
      spec: { name: 'alerts.unsubscribe_push', title: 'Turn off phone alerts', description: 'Stop push alerts to one device (by endpoint) or to all your devices.', input: S({ endpoint: { type: 'string' } }), scope: 'write', confirm: 'none', test: 'test/unit/alerts.test.ts' },
      handler: async ({ endpoint }, call: any) => ({ removed: await core.push.unsubscribe(call.caller.user.id, endpoint) }),
    },
    {
      spec: { name: 'alerts.send_test', title: 'Send a test alert', description: 'Put a test question in your own inbox and send it on every channel your settings allow, to check notifications, push and email work.', input: S({ kind: { enum: ['question', 'approval', 'failed', 'done'], default: 'question' } }), scope: 'write', confirm: 'none', test: 'test/unit/alerts.test.ts' },
      handler: async ({ kind }, call: any) => core.alerts.raise({ teamId: call.team.id, personId: call.caller.user.id, kind, title: 'Test alert: does this reach you?', body: 'Answer with 1 or 2. Nothing else happens.', options: ['Yes, got it', 'Something is off'], source: 'alerts' }),
    },
  ];
}
