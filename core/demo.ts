// Demo servers (WOS_DEMO=1): every visitor gets a private sandbox team with fictional example data and
// three agents on the demo model, so the grid, plans, inbox and alerts can be tried with no account or key.
import type { Core } from './core.ts';
import { ROLE_SCOPES } from './types.ts';
import { now } from './util.ts';

const PEOPLE = ['Sam', 'Jordan', 'Casey', 'Riley'];

export async function ensureDemo(core: Core) {
  // Sandboxes last a day.
  const old = await core.db.query<any>("SELECT id FROM teams WHERE slug LIKE 'demo-%' AND created_at < ?", [new Date(Date.now() - 86400e3).toISOString()]);
  for (const t of old) await core.db.run('UPDATE teams SET archived_at = ? WHERE id = ?', [now(), t.id]);
}

export async function demoSignIn(core: Core) {
  const n = Math.floor(Math.random() * 1e6).toString(36);
  const name = PEOPLE[Math.floor(Math.random() * PEOPLE.length)];
  const user = await core.users.create({ name: `${name} (demo)`, email: `${name.toLowerCase()}.${n}@acme-dental.example` });
  const team = await core.teams.create('Acme Dental', user.id, { slug: `demo-${n}` });
  const caller = { actor: { kind: 'person' as const, id: user.id, name: user.name }, user, team, role: 'owner' as const, scopes: ROLE_SCOPES.owner };
  const call = (tool: string, input: unknown) => core.catalogue.call(tool, input, caller, 'system').then((r) => r.result as any).catch((e) => { core.log.warn(`demo seed ${tool}: ${e.message}`); return null; });
  const researcher = await call('agents.create', { name: 'Researcher', role: 'Finds and checks facts about clinics and contacts, then writes short summaries with sources.', provider_id: 'demo', budget: { max_turns: 20 } });
  const writer = await call('agents.create', { name: 'Follow-up writer', role: 'Drafts friendly follow-up emails for open deals. Never sends without approval.', provider_id: 'demo', budget: { max_turns: 20 } });
  await call('agents.create', { name: 'Board keeper', role: 'Keeps the board tidy: closes finished tasks and nudges overdue ones.', provider_id: 'demo', budget: { max_turns: 20 } });
  if (researcher) await call('agents.start', { agent_id: researcher.id, goal: 'Research the three biggest open deals in the CRM and list next steps' });
  if (writer) await call('agents.start', { agent_id: writer.id, goal: 'Draft a follow-up email for Birch Law about the proposal' });
  return user;
}
