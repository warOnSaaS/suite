import type { ToolSpec, Scope } from '../packages/tools/index.d.ts';
import type { Actor, Team, Call, Handler, AppServer, Manifest } from '../packages/manifest/index.d.ts';

export type { ToolSpec, Scope, Actor, Team, Call, Handler, AppServer, Manifest };

export type Role = 'owner' | 'admin' | 'member' | 'guest';
export const ROLE_SCOPES: Record<Role, Scope[]> = {
  owner: ['read', 'write', 'delete', 'admin'],
  admin: ['read', 'write', 'delete', 'admin'],
  member: ['read', 'write', 'delete'],
  guest: ['read'],
};

export interface User { id: string; name: string; email: string | null; github_login: string | null; avatar_url: string | null }

/** Who is calling a tool, before the call is made. */
export interface Caller {
  actor: Actor;
  user: User | null;
  team: Team | null;
  role: Role | null;
  scopes: Scope[];
  sessionId?: string;
  /** Set when a person approved this exact call. */
  approved?: boolean;
  /** A person acting through an outside channel (an email command): confirm: human tools still wait for a
   *  click on a signed link or the inbox, as for agents. */
  untrusted?: boolean;
  /** For agents: the run the call belongs to. */
  runId?: string;
}

export type Via = Call['via'];

export interface ToolDef extends ToolSpec { app: string; handler: Handler }

export interface CoreTool { spec: Omit<ToolSpec, 'output'> & { output?: ToolSpec['output'] }; handler: Handler }
