// Types for wos-app.json and for the two parts an app gives the suite: the server part and the screen part.
import type { ToolSpec, Scope } from '../tools/index.d.ts';

export interface Manifest {
  $schema?: string;
  id: string;
  name: string;
  description: string;
  version: string;
  license?: string;
  requires: { core: string; apps?: Record<string, string> };
  tools: string;
  tables?: string;
  server?: string;
  screens?: string;
  icon?: string;
  nav?: { label?: string; order?: number; hidden?: boolean };
  events?: { emits?: string[]; listens?: string[] };
  needs?: { services?: string[]; permissions?: string[]; desktop?: string[]; env?: string[] };
  data?: { onDisable?: 'keep'; exports?: string[] };
  core?: boolean;
  mount?: { path: string; start?: string };
}

// ---------- the server part ----------

/** Who is acting. Agents act for a person and never get more than that person's scopes. */
export interface Actor {
  kind: 'person' | 'agent' | 'system';
  id: string;
  name: string;
  /** For an agent: the person it works for. */
  personId?: string;
}

export interface Team { id: string; slug: string; name: string }

/** Everything a tool handler knows about the call it is serving. */
export interface Call {
  actor: Actor;
  team: Team;
  scopes: Scope[];
  /** Where the call came from. Screens and REST share a handler; this is for the audit log and live feed. */
  via: 'screen' | 'rest' | 'mcp' | 'agent' | 'email' | 'system';
  /** Call another tool (any app that is on) as the same caller, with the same scope limits. */
  callTool(name: string, input?: unknown): Promise<unknown>;
  /** Publish an event for this team: `${appId}.noun.past_verb`. */
  emit(name: string, data?: unknown): void;
}

export type Handler = (input: any, call: Call) => unknown | Promise<unknown>;

/** Portable SQL. Write `?` placeholders; the suite converts them for Postgres.
 *  Portable column rules: ids TEXT, times TEXT (ISO 8601 UTC), flags INTEGER 0/1, JSON as TEXT, money INTEGER cents.
 *  Every app table starts with the app id and carries team_id. */
export interface Db {
  dialect: 'postgres' | 'sqlite';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export interface WosEvent<T = unknown> { id: string; team_id: string; name: string; data: T; actor?: Actor; at: string }

/** What register(ctx) receives. */
export interface AppContext {
  app: Manifest;
  db: Db;
  events: {
    publish(teamId: string, name: string, data?: unknown, actor?: Actor): void;
    /** name may end in .* (chat.*) */
    on(name: string, fn: (e: WosEvent) => void | Promise<void>): () => void;
  };
  alerts: {
    /** Ask a person something. Shows in their inbox and goes out on their alert channels. */
    raise(a: { teamId: string; personId: string; kind: 'approval' | 'question' | 'blocked' | 'done' | 'failed'; title: string; body?: string; options?: string[]; ref?: unknown }): Promise<{ id: string }>;
    /** An answer that reached this app (a reply to an alert email). Same effect as answering in the inbox. */
    answer(alertId: string, personId: string, answer: string | number, via?: string): Promise<unknown>;
  };
  /** Call any tool as a team member outside a request (run by email, schedules, webhooks). Uses the member's role
   *  scopes (or fewer), is audited with `via`, and is untrusted unless `trusted`: confirm: human tools wait for the
   *  person's yes. Returns the result, or { pending } while waiting. Throws (code no_tool) when that app is off. */
  callAs(who: { teamId: string; personId: string; via?: 'email' | 'system'; label?: string; scopes?: Scope[]; trusted?: boolean }, name: string, input?: unknown): Promise<unknown>;
  /** Team membership: the one source of truth. Listen to team.member.joined, team.member.left and team.member.role_changed. */
  people: {
    members(teamId: string): Promise<{ id: string; name: string; email: string | null; github_login: string | null; role: 'owner' | 'admin' | 'member' | 'guest' }[]>;
    byEmail(teamId: string, email: string): Promise<{ id: string; name: string; email: string | null; role: string } | null>;
    teamsOf(email: string): Promise<Team[]>;
    /** Teams that have this app on. */
    teamsWithApp(): Promise<Team[]>;
  };
  /** Read environment settings the manifest lists in needs.env. */
  env(name: string): string | undefined;
  /** A folder this app may write files to (local disk, or a cache when files live in object storage). */
  dataDir: string;
  publicUrl: string;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

/** What register(ctx) returns. */
export interface AppServer {
  /** One handler per tool in tools.json, keyed by full tool name. A tool with no handler fails the catalogue test. */
  handlers: Record<string, Handler>;
  /** Non-tool traffic only: file streams, media and inbound webhooks, under /files/<id>/, /media/<id>/ and /hooks/<id>/.
   *  Return true when handled. `call` is null when nobody is signed in. */
  routes?(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, call: Call | null): boolean | Promise<boolean>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  /** Called when a team turns the app on or off. Do not delete data here. */
  onEnable?(team: Team): void | Promise<void>;
  onDisable?(team: Team): void | Promise<void>;
  /** Your own pages, served by the suite under /m/<id>/ for members of a team with the app on (needs "mount" in
   *  wos-app.json). Use only until a screen part exists. */
  mount?(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, call: Call | null): unknown;
  /** The Email app offers this: the core sends alert emails through it when Email is on for the team.
   *  Replies come back through ctx.alerts.answer. */
  alertTransport?: { send(a: { alertId: string; teamId: string; personId: string; to: string; title: string; body: string; options: string[]; kind: string; link: string; answerLinks: string[] }): Promise<void> };
  /** Everything this team has in the app, for "export everything". */
  exportTeam?(team: Team): Promise<Record<string, unknown>>;
}

export type Register = (ctx: AppContext) => AppServer | Promise<AppServer>;

// ---------- the screen part ----------

export interface ScreenContext {
  /** The only way a screen talks to the server: POST /api/tools/<name>. */
  callTool<T = any>(name: string, input?: unknown): Promise<T>;
  /** Live events for this team over the suite's socket. Returns an unsubscribe function. */
  on(name: string, fn: (e: WosEvent) => void): () => void;
  /** The path inside the app at mount time, for example "/" or "/channels/ch_general". */
  path: string;
  /** Go to a path inside the app. The suite changes the address bar to /a/<id><path> (/agents<path> for Agents)
   *  and then calls update(path) on what mount() returned. The screen is not remounted. */
  navigate(path: string): void;
  me: { id: string; name: string; email?: string; github?: string };
  team: Team;
  toast(message: string): void;
}

export interface ScreenModule {
  title?: string;
  /** Draw the app into el. Return a function (or { unmount }) to clean up; update(path) is called on in-app navigation. */
  mount(el: HTMLElement, ctx: ScreenContext): void | (() => void) | { unmount(): void; update?(path: string): void };
}

export type { ToolSpec, Scope };
export const APP_ID: RegExp;
export function checkManifest(m: unknown, opts?: { core?: boolean }): string[];
export function satisfies(version: string, range: string): boolean;
export function migrationOrder(names: string[], dialect: 'postgres' | 'sqlite'): { id: string; file: string }[];
