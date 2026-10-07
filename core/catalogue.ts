// The merged tool catalogue and the one call path every caller goes through: screens (/api/tools),
// programs (REST), agents (MCP and wOS's own runtime) and email. Checks, in order: the tool exists and its
// app is on for the team; sign-in; scope; input schema; human approval for agents; then the handler runs and
// the call is written to the audit log.
import { checkTool } from '../packages/tools/index.mjs';
import type { Core } from './core.ts';
import type { Caller, ToolDef, Via, CoreTool, ToolSpec, Handler } from './types.ts';
import { validate } from './validate.ts';
import { WosError, id, now, parse } from './util.ts';

export interface CallResult { result?: unknown; pending?: { approval_id: string; alert_id: string; message: string } }

const DEFAULT_OUTPUT = { type: 'object' } as const;

export class Catalogue {
  core: Core;
  tools = new Map<string, ToolDef>();

  constructor(core: Core) { this.core = core; }

  addCore(app: string, defs: CoreTool[]) {
    for (const d of defs) this.add(app, { ...d.spec, output: d.spec.output ?? DEFAULT_OUTPUT } as ToolSpec, d.handler);
  }

  add(app: string, spec: ToolSpec, handler: Handler | undefined) {
    const problems = checkTool(spec, spec.name.split('.')[0]);
    if (problems.length) throw new Error(`Tool ${spec.name} (${app}) is not valid: ${problems.join(' ')}`);
    if (!handler) throw new Error(`Tool ${spec.name} (${app}) has no handler.`);
    this.tools.set(spec.name, { ...spec, app, handler });
  }

  removeApp(app: string) {
    for (const [n, t] of this.tools) if (t.app === app) this.tools.delete(n);
  }

  /** The tools a caller can see: apps on for their team, within their scopes. */
  async visible(caller: Caller | null, { includeHidden = true } = {}): Promise<ToolDef[]> {
    const out: ToolDef[] = [];
    for (const t of this.tools.values()) {
      if (!includeHidden && t.hidden) continue;
      if (!caller?.team) { if (t.public) out.push(t); continue; }
      if (!(await this.core.registry.isOn(caller.team.id, t.app))) continue;
      if (!t.public && !caller.scopes.includes(t.scope)) continue;
      out.push(t);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(name: string, input: unknown, caller: Caller | null, via: Via): Promise<CallResult> {
    const t = this.tools.get(name);
    const started = Date.now();
    if (!t) throw new WosError('no_tool', `There is no tool called ${name}.`, 404);
    if (!t.public && !caller?.user && caller?.actor.kind !== 'system') throw new WosError('sign_in', 'Sign in first.', 401);
    if (caller?.team && !(await this.core.registry.isOn(caller.team.id, t.app))) throw new WosError('no_tool', `${this.core.registry.name(t.app)} is turned off for this team, so ${name} is not available.`, 404);
    if (!t.public && caller && !caller.scopes.includes(t.scope)) {
      await this.audit(t, caller, via, input, 'denied', `missing ${t.scope} scope`, started);
      throw new WosError('scope', `This needs ${t.scope} access, which ${caller.actor.kind === 'agent' ? `${caller.actor.name} was not given` : 'you do not have here'}.`, 403);
    }
    const v = validate(t.input, input ?? {});
    if (!v.ok) throw new WosError('invalid_input', v.error, 400);

    if (t.confirm === 'human' && caller?.actor.kind === 'agent' && !caller.approved) {
      const pending = await this.requestApproval(t, v.value, caller);
      await this.audit(t, caller, via, v.value, 'pending', null, started);
      return { pending };
    }

    const call = this.makeCall(caller, via);
    try {
      const result = await t.handler(v.value, call);
      await this.audit(t, caller, via, v.value, 'ok', null, started);
      return { result: result ?? {} };
    } catch (e: any) {
      await this.audit(t, caller, via, v.value, 'error', e.message, started);
      if (e instanceof WosError) throw e;
      throw new WosError('failed', e.message || 'Something went wrong.', 400);
    }
  }

  makeCall(caller: Caller | null, via: Via) {
    const core = this.core;
    const actor = caller?.actor ?? { kind: 'system' as const, id: 'system', name: 'wOS' };
    const team = caller?.team ?? { id: '', slug: '', name: '' };
    return {
      actor,
      team,
      scopes: caller?.scopes ?? [],
      via,
      caller,
      callTool: async (n: string, i?: unknown) => {
        const r = await core.catalogue.call(n, i, caller, via);
        if (r.pending) return { pending: r.pending };
        return r.result;
      },
      emit: (n: string, d?: unknown) => { if (team.id) core.events.publish(team.id, n, d, actor as any); },
    };
  }

  private async requestApproval(t: ToolDef, input: unknown, caller: Caller) {
    const personId = caller.actor.personId ?? caller.user?.id;
    if (!personId || !caller.team) throw new WosError('no_person', 'Nobody to approve this call.', 400);
    const approvalId = id('ap');
    const summary = summarise(input);
    const alert = await this.core.alerts.raise({
      teamId: caller.team.id,
      personId,
      kind: 'approval',
      title: `${caller.actor.name} wants to: ${t.title.toLowerCase()}`,
      body: `${t.description.split('. ')[0]}.${summary ? `\n\n${summary}` : ''}`,
      options: ['Approve', 'Deny'],
      ref: { approval_id: approvalId, tool: t.name, run_id: caller.runId ?? null },
      source: t.app,
    });
    await this.core.db.run('INSERT INTO approvals (id, team_id, alert_id, tool, input, actor, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      approvalId, caller.team.id, alert.id, t.name, JSON.stringify(input), JSON.stringify({ actor: caller.actor, scopes: caller.scopes, runId: caller.runId ?? null, userId: caller.user?.id ?? null }), 'pending', now(),
    ]);
    return { approval_id: approvalId, alert_id: alert.id, message: `Waiting for a person to approve ${t.name}.` };
  }

  /** A person answered an approval alert: run the call as the agent (approved), or record the no. */
  async decideApproval(approvalId: string, approve: boolean, deciderId: string) {
    const a = await this.core.db.get<any>('SELECT * FROM approvals WHERE id = ?', [approvalId]);
    if (!a || a.status !== 'pending') return null;
    const saved = parse<any>(a.actor, {});
    const team = await this.core.teams.get(a.team_id);
    const user = saved.userId ? await this.core.users.get(saved.userId) : null;
    let status = approve ? 'done' : 'denied';
    let result: unknown = approve ? null : { denied: true, message: 'The person said no.' };
    if (approve) {
      try {
        const r = await this.call(a.tool, parse(a.input, {}), { actor: saved.actor, user, team, role: 'member', scopes: saved.scopes, approved: true, runId: saved.runId ?? undefined }, 'agent');
        result = r.result;
      } catch (e: any) {
        status = 'failed';
        result = { error: e.message };
      }
    }
    await this.core.db.run('UPDATE approvals SET status = ?, result = ?, decided_at = ?, decided_by = ? WHERE id = ?', [status, JSON.stringify(result), now(), deciderId, approvalId]);
    this.core.events.publish(a.team_id, 'alerts.approval.decided', { approval_id: approvalId, tool: a.tool, status, result, run_id: saved.runId ?? null });
    return { status, result };
  }

  private async audit(t: ToolDef, caller: Caller | null, via: Via, input: unknown, status: string, error: string | null, started: number) {
    if (t.scope === 'read' && status === 'ok' && via === 'screen') return; // screens read constantly; keep the log about actions
    const a = caller?.actor;
    await this.core.db.run('INSERT INTO audit (id, team_id, actor_kind, actor_id, actor_name, person_id, tool, via, input, status, error, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id('au'), caller?.team?.id ?? null, a?.kind ?? 'anonymous', a?.id ?? '-', a?.name ?? null, a?.personId ?? caller?.user?.id ?? null, t.name, via, redact(input), status, error, Date.now() - started, now(),
    ]).catch(() => {});
  }
}

function summarise(input: unknown) {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>).slice(0, 6).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 160) : JSON.stringify(v)?.slice(0, 160)}`).join('\n');
}

// Never store secrets in the audit log.
function redact(input: unknown) {
  const s = JSON.stringify(input ?? {}, (k, v) => (/key|secret|token|password/i.test(k) && typeof v === 'string' ? '[hidden]' : v));
  return s.length > 4000 ? `${s.slice(0, 4000)}...` : s;
}
