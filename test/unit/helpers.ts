// A fresh core on an in-memory SQLite database, with a person and a team, for tests.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Core } from '../../core/core.ts';
import { ROLE_SCOPES, type Caller, type Role } from '../../core/types.ts';

export async function makeCore(env: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-test-'));
  const core = new Core({ env: { WOS_DB: 'memory', WOS_SECRET_KEY: 'test-key', PUBLIC_URL: 'http://localhost:9', WOS_DEFAULT_APPS: '', WOS_REDUCED: '1', WOS_DEMO_PACE_MS: '0', ...env }, dataDir, quiet: true });
  await core.start();
  return core;
}

export async function person(core: Core, name = 'Sam', role: Role = 'owner', team?: { id: string; slug: string; name: string }) {
  const user = await core.users.create({ name, email: `${name.toLowerCase()}@acme-dental.example` });
  const t = team ?? (await core.teams.create('Acme Dental', user.id));
  if (team) await core.teams.addMember(team.id, user.id, role);
  const caller: Caller = { actor: { kind: 'person', id: user.id, name }, user, team: t, role, scopes: ROLE_SCOPES[role] };
  const call = async (tool: string, input: unknown = {}) => (await core.catalogue.call(tool, input, caller, 'screen')).result as any;
  return { user, team: t, caller, call };
}
