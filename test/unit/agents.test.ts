// The Agents app: agents.create, agents.get, agents.list, agents.update, agents.archive, agents.start, agents.runs,
// agents.get_run, agents.set_plan, agents.complete_step, agents.ask, agents.message, agents.pause, agents.resume,
// agents.stop, agents.retry, agents.report, agents.get_layout, agents.save_layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, person, fakeModelServer } from './helpers.ts';

const pump = async (core: any, teamId: string, n = 12) => { for (let i = 0; i < n; i++) await core.agentsPump(teamId); };

test('a run makes a plan, shows real progress, asks the person, and finishes', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const ag = await sam.call('agents.create', { name: 'Researcher', role: 'Find things', provider_id: 'demo', budget: { max_turns: 30 } });
  assert.equal((await sam.call('agents.get', { agent_id: ag.id })).name, 'Researcher');
  const run = await sam.call('agents.start', { agent_id: ag.id, goal: 'Research our open deals' });
  assert.equal(run.status, 'working');
  await pump(core, sam.team.id);
  let r = await sam.call('agents.get_run', { run_id: run.id });
  assert.equal(r.status, 'needs_you');
  assert.equal(r.steps_total, 4);
  assert.equal(r.percent, 50, 'two of four steps, computed from the plan');
  assert.ok(r.steps.filter((s: any) => s.done_at).every((s: any) => s.evidence), 'every done step has evidence');
  const q = (await sam.call('alerts.list')).alerts[0];
  assert.equal(q.kind, 'question');
  await sam.call('alerts.answer', { alert_id: q.id, option: 0 });
  await pump(core, sam.team.id);
  r = await sam.call('agents.get_run', { run_id: run.id });
  assert.equal(r.status, 'done');
  assert.equal(r.percent, 100);
  assert.ok(r.events.some((e: any) => e.kind === 'answer'));
  const listed = await sam.call('agents.list');
  assert.equal(listed.agents[0].last_run.status, 'done');
  const runs = await sam.call('agents.runs', { status: 'done' });
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.counts.done, 1);
  // Done goes to the inbox.
  assert.ok((await sam.call('alerts.list')).alerts.some((a: any) => a.kind === 'done'));
  await core.stop();
});

test('no plan, no percent; changing the plan says so; evidence is required', async () => {
  const core = await makeCore({ WOS_REDUCED: '0', WOS_DEMO_PACE_MS: '60000' });
  const sam = await person(core);
  const ag = await sam.call('agents.create', { name: 'Planner', role: 'Plans', provider_id: 'demo' });
  const run = await sam.call('agents.start', { agent_id: ag.id, goal: 'Plan the week' });
  await sam.call('agents.pause', { run_id: run.id });
  let r = await sam.call('agents.get_run', { run_id: run.id });
  assert.equal(r.percent, null);
  assert.equal(r.status, 'idle');
  await sam.call('agents.set_plan', { run_id: run.id, steps: ['One', 'Two', 'Three'] });
  await sam.call('agents.complete_step', { run_id: run.id, n: 1, evidence: 'crm record d_acme01' });
  await assert.rejects(sam.call('agents.complete_step', { run_id: run.id, n: 2, evidence: '' }), /evidence/);
  await assert.rejects(sam.call('agents.complete_step', { run_id: run.id, n: 9, evidence: 'nope' }), /no step 9/);
  r = await sam.call('agents.get_run', { run_id: run.id });
  assert.equal(r.percent, 33);
  await sam.call('agents.set_plan', { run_id: run.id, steps: ['One', 'Two', 'Three', 'Four', 'Five'] });
  r = await sam.call('agents.get_run', { run_id: run.id });
  assert.equal(r.plan_note, 'Plan changed: 1 of 3 became 1 of 5');
  assert.equal(r.percent, 20);
  await sam.call('agents.resume', { run_id: run.id });
  await sam.call('agents.message', { run_id: run.id, text: 'Keep it short' });
  await sam.call('agents.stop', { run_id: run.id });
  assert.equal((await sam.call('agents.get_run', { run_id: run.id })).status, 'idle');
  await sam.call('agents.retry', { run_id: run.id });
  assert.equal((await sam.call('agents.get_run', { run_id: run.id })).status, 'working');
  await core.stop();
});

test('a budget stops a run as failed, with an alert; retry with more budget', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const ag = await sam.call('agents.create', { name: 'Tiny', role: 'Small budget', provider_id: 'demo', budget: { max_turns: 2 } });
  const run = await sam.call('agents.start', { agent_id: ag.id, goal: 'Do a lot' });
  await pump(core, sam.team.id, 6);
  const r = await sam.call('agents.get_run', { run_id: run.id });
  assert.equal(r.status, 'failed');
  assert.match(r.status_note, /budget of 2 turns/);
  assert.ok((await sam.call('alerts.list')).alerts.some((a: any) => a.kind === 'failed'));
  await sam.call('agents.update', { agent_id: ag.id, budget: { max_turns: 50 } });
  await sam.call('agents.retry', { run_id: run.id });
  await pump(core, sam.team.id, 3);
  assert.notEqual((await sam.call('agents.get_run', { run_id: run.id })).status, 'failed');
  await sam.call('agents.archive', { agent_id: ag.id });
  assert.equal((await sam.call('agents.list')).agents.length, 0);
  await core.stop();
});

test('three failing tool calls in a row mark the run blocked', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const fake = await fakeModelServer(() => ({ tool: { name: 'team.set_role', args: { user_id: 'nobody', role: 'member' } } }));
  const p = await sam.call('models.add_provider', { kind: 'openai_compatible', base_url: fake.url });
  const ag = await sam.call('agents.create', { name: 'Clumsy', role: 'Tries things', provider_id: p.id, model: 'fake-1', scopes: ['read', 'write'] });
  const run = await sam.call('agents.start', { agent_id: ag.id, goal: 'Change a role' });
  await pump(core, sam.team.id, 5);
  const r = await sam.call('agents.get_run', { run_id: run.id });
  assert.equal(r.status, 'blocked');
  assert.match(r.status_note, /scope/, 'an agent never gets admin unless given it');
  await fake.close();
  await core.stop();
});

test('agents.report: an outside agent shows up in the grid', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const ext = { ...sam.caller, actor: { kind: 'agent' as const, id: 'mcp:x', name: 'Connected app', personId: sam.user.id } };
  const call = async (t: string, i: unknown) => (await core.catalogue.call(t, i, ext, 'mcp')).result as any;
  const r = await call('agents.report', { name: 'Claude Code', goal: 'Fix the login bug', steps: ['Reproduce', 'Fix', 'Test'], status: 'working', note: 'Reproducing' });
  assert.equal(r.runtime, 'external');
  const r2 = await call('agents.report', { run_id: r.id, done_step: 1, evidence: 'failing test test/login.test.ts', status: 'needs_you', note: 'Which fix?' });
  assert.equal(r2.percent, 33);
  assert.equal(r2.status, 'needs_you');
  assert.ok((await sam.call('alerts.list')).alerts.some((a: any) => /Claude Code needs you/.test(a.title)));
  await core.stop();
});

test('panel layout is saved per person', async () => {
  const core = await makeCore();
  const sam = await person(core);
  assert.deepEqual(await sam.call('agents.get_layout'), { size: 4, order: [], focus: null });
  await sam.call('agents.save_layout', { size: 6, order: ['run_a', 'run_b'] });
  assert.equal((await sam.call('agents.get_layout')).size, 6);
  await assert.rejects(sam.call('agents.save_layout', { size: 3 }), /one of/);
  await core.stop();
});
