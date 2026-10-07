// The suite core: one object that holds the database and every shared service, built once per server.
import path from 'node:path';
import { openDb, defaultDataDir, type Database } from './db.ts';
import { migrate } from './migrate.ts';
import { initKey } from './crypto.ts';
import { Events } from './events.ts';
import { Catalogue } from './catalogue.ts';
import { Registry } from './registry.ts';
import { Users, Teams, accountTools, teamTools } from './accounts.ts';
import { Alerts, alertTools } from './alerts.ts';
import { Mailer } from './mail.ts';
import { Push } from './push.ts';
import { Models, modelTools } from './models/index.ts';
import { conversationTools } from './conversations.ts';
import { appTools } from './apps.ts';
import { hostingTools, auditTools, eventTools } from './hosting.ts';

export const CORE_VERSION = '0.1.0';
export const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

export interface CoreOptions { env?: NodeJS.ProcessEnv; dataDir?: string; quiet?: boolean }

export class Core {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  db!: Database;
  events!: Events;
  catalogue: Catalogue;
  registry: Registry;
  users: Users;
  teams: Teams;
  alerts: Alerts;
  mail: Mailer;
  push: Push;
  models: Models;
  /** Vercel and other serverless hosts: no sockets, no background loop; agents advance while someone watches. */
  reduced: boolean;
  demo: boolean;
  publicUrl: string;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  private timers: NodeJS.Timeout[] = [];
  started = false;

  constructor(opts: CoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.dataDir = opts.dataDir ?? defaultDataDir(this.env);
    this.reduced = this.env.WOS_REDUCED === '1' || !!this.env.VERCEL;
    this.demo = this.env.WOS_DEMO === '1';
    this.publicUrl = (this.env.PUBLIC_URL || `http://localhost:${this.env.PORT || 8080}`).replace(/\/$/, '');
    const quiet = opts.quiet;
    this.log = {
      info: (...a) => { if (!quiet) console.log('[wos]', ...a); },
      warn: (...a) => { if (!quiet) console.warn('[wos]', ...a); },
      error: (...a) => console.error('[wos]', ...a),
    };
    this.catalogue = new Catalogue(this);
    this.registry = new Registry(this);
    this.users = new Users(this);
    this.teams = new Teams(this);
    this.alerts = new Alerts(this);
    this.mail = new Mailer(this);
    this.push = new Push(this);
    this.models = new Models(this);
  }

  async start() {
    if (this.started) return this;
    this.log.info(`server key ${initKey(this.env, this.dataDir)}`);
    this.db = await openDb(this.env, this.dataDir);
    this.log.info(`storage: ${this.db.describe}`);
    await migrate(this.db, 'core', path.join(ROOT, 'core', 'migrations'), (s) => this.log.info(s));
    this.events = new Events(this.db, (s) => this.log.warn(s));
    await this.events.start();

    for (const [ns, tools] of Object.entries({ account: accountTools(this), team: teamTools(this), apps: appTools(this), models: modelTools(this), conversations: conversationTools(this), alerts: alertTools(this), hosting: hostingTools(this), audit: auditTools(this), events: eventTools(this) })) {
      this.catalogue.addCore(ns, tools);
    }
    await this.push.start();
    await this.registry.start();
    this.alerts.startEscalation();
    if (this.demo) await (await import('./demo.ts')).ensureDemo(this);
    this.started = true;
    return this;
  }

  every(ms: number, fn: () => unknown) {
    if (this.reduced) return;
    const t = setInterval(() => { Promise.resolve(fn()).catch((e) => this.log.warn(e.message)); }, ms);
    t.unref?.();
    this.timers.push(t);
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    await this.registry.stop();
    await this.db?.close();
  }
}

let shared: Promise<Core> | null = null;
/** One core per process (the HTTP server and serverless functions share it). */
export function getCore(opts?: CoreOptions) {
  shared ??= new Core(opts).start();
  return shared;
}
