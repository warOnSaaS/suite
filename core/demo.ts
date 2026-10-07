// Demo servers (WOS_DEMO=1): every visitor gets a private sandbox team with fictional example data and
// three agents on the demo model, so the grid, plans, inbox and alerts can be tried with no account or key.
//
// The visitor's cookie is a signed demo pass (wosd_...), not a database session. On serverless hosting each
// copy of the server has its own memory, so when a request lands on a copy that has never seen this sandbox,
// the pass rebuilds it there with the same ids. Changes made on one copy may not show on another; the demo says so.
import type { Core } from './core.ts';
import { ROLE_SCOPES, type Caller } from './types.ts';
import { now, id } from './util.ts';
import { sign, verify } from './crypto.ts';
import { sha256 } from './util.ts';

const PEOPLE = ['Sam', 'Jordan', 'Casey', 'Riley'];
const restoring = new Map<string, Promise<void>>();

export async function ensureDemo(core: Core) {
  // Sandboxes last a day.
  const old = await core.db.query<any>("SELECT id FROM teams WHERE slug LIKE 'demo-%' AND created_at < ?", [new Date(Date.now() - 86400e3).toISOString()]);
  for (const t of old) await core.db.run('UPDATE teams SET archived_at = ? WHERE id = ?', [now(), t.id]);
}

/** A new sandbox: returns the signed pass to put in the cookie. */
export async function demoSignIn(core: Core) {
  const n = Math.floor(Math.random() * 1e6).toString(36);
  const name = PEOPLE[Math.floor(Math.random() * PEOPLE.length)];
  const pass = { u: id('u'), t: id('t'), n: `${name} (demo)`, e: `${name.toLowerCase()}.${n}@acme-dental.example`, s: `demo-${n}` };
  await build(core, pass);
  return `wosd_${sign({ k: 'demo', ...pass }, 7 * 86400)}`;
}

async function build(core: Core, p: { u: string; t: string; n: string; e: string; s: string }) {
  const user = await core.users.create({ id: p.u, name: p.n, email: p.e });
  const team = await core.teams.create('Acme Dental', user.id, { slug: p.s, id: p.t });
  const caller = { actor: { kind: 'person' as const, id: user.id, name: user.name }, user, team, role: 'owner' as const, scopes: ROLE_SCOPES.owner };
  const call = (tool: string, input: unknown) => core.catalogue.call(tool, input, caller, 'system').then((r) => r.result as any).catch((e) => { core.log.warn(`demo seed ${tool}: ${e.message}`); return null; });
  const researcher = await call('agents.create', { name: 'Researcher', role: 'Finds and checks facts about clinics and contacts, then writes short summaries with sources.', provider_id: 'demo', budget: { max_turns: 20 } });
  const writer = await call('agents.create', { name: 'Follow-up writer', role: 'Drafts friendly follow-up emails for open deals. Never sends without approval.', provider_id: 'demo', budget: { max_turns: 20 } });
  await call('agents.create', { name: 'Board keeper', role: 'Keeps the board tidy: closes finished tasks and nudges overdue ones.', provider_id: 'demo', budget: { max_turns: 20 } });
  const r1 = researcher && (await call('agents.start', { agent_id: researcher.id, goal: 'Research the three biggest open deals in the CRM and list next steps' }));
  const r2 = writer && (await call('agents.start', { agent_id: writer.id, goal: 'Draft a follow-up email for Birch Law about the proposal' }));
  // Same ids on every server copy, so screens that reach two copies see one set of agents and runs.
  const fixed = (kind: string, n: string) => `${kind}_${sha256(`${p.u}:${n}`).replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase()}`;
  const agents = await core.db.query<any>('SELECT id, name FROM agents WHERE team_id = ?', [team.id]);
  for (const a of agents) {
    const to = fixed('ag', a.name);
    await core.db.run('UPDATE agents SET id = ? WHERE id = ?', [to, a.id]);
    await core.db.run('UPDATE agent_runs SET agent_id = ? WHERE agent_id = ?', [to, a.id]);
  }
  for (const [r, n] of [[r1, 'r1'], [r2, 'r2']] as const) {
    if (!r) continue;
    const to = fixed('run', n);
    for (const t of ['agent_steps', 'agent_events']) await core.db.run(`UPDATE ${t} SET run_id = ? WHERE run_id = ?`, [to, r.id]);
    await core.db.run('UPDATE agent_runs SET id = ? WHERE id = ?', [to, r.id]);
  }
}

/** The caller behind a demo pass, rebuilding the sandbox on this copy of the server if it is not here. */
export async function callerFromPass(core: Core, raw: string): Promise<Caller | null> {
  if (!core.demo) return null;
  const p = verify<{ u: string; t: string; n: string; e: string; s: string }>(raw.slice(5), 'demo');
  if (!p) return null;
  let user = await core.users.get(p.u);
  if (!user) {
    if (!restoring.has(p.u)) restoring.set(p.u, build(core, p).catch((e) => core.log.warn(`demo rebuild: ${e.message}`)).finally(() => restoring.delete(p.u)));
    await restoring.get(p.u);
    user = await core.users.get(p.u);
    if (!user) return null;
  }
  const team = await core.teams.get(p.t);
  if (!team) return null;
  return { actor: { kind: 'person', id: user.id, name: user.name }, user, team: { id: team.id, slug: team.slug, name: team.name }, role: 'owner', scopes: ROLE_SCOPES.owner };
}
