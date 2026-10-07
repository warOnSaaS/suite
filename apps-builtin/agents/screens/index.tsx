// The Agents app's screens: a grid of live panels (1, 2, 4 or 6, drag to rearrange), status colours,
// progress computed from each run's plan, and the saved agents. Quiet and keyboard first, like getone.one.
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { callTool, on } from '../../../apps/shell/src/api.ts';
import { Btn, Dot, Empty, Icon, Kbd, STATUS_LABEL, ago, toast, useTool } from '../../../apps/shell/src/kit.tsx';

interface Run { id: string; agent_id: string; agent_name: string; model: string | null; runtime: string; goal: string; status: string; status_note: string | null; percent: number | null; steps_done: number; steps_total: number; current_step: { n: number; text: string } | null; plan_note: string | null; spend: { tokens: number; turns: number; budget_tokens: number; budget_turns: number; percent: number }; waiting_alert_id: string | null; task_ref?: string | null; started_at: string; updated_at: string; ended_at: string | null }
interface Agent { id: string; name: string; role: string; provider_id: string | null; model: string | null; tools: string[] | null; scopes: string[]; budget: any; last_run: Run | null }
interface Ev { id: string; kind: string; payload: any; at: string }

type Ctx = { path: string; navigate: (p: string) => void };

export default {
  title: 'Agents',
  mount(el: HTMLElement, ctx: Ctx) {
    const root = createRoot(el);
    const draw = (path: string) => root.render(<AgentsApp path={path} navigate={ctx.navigate} />);
    draw(ctx.path);
    return { unmount: () => root.unmount(), update: draw };
  },
};

function AgentsApp({ path, navigate }: { path: string; navigate: (p: string) => void }) {
  const m = /^\/run\/([^/]+)/.exec(path);
  if (m) return <Focus runId={m[1]} navigate={navigate} />;
  return <Grid navigate={navigate} />;
}

const err = (e: any) => toast(e.message ?? 'Something went wrong.');

function Grid({ navigate }: { navigate: (p: string) => void }) {
  const runs = useTool<{ runs: Run[]; counts: Record<string, number> }>('agents.runs', { limit: 60 });
  const agents = useTool<{ agents: Agent[] }>('agents.list');
  const layout = useTool<{ size: number; order: string[]; focus: string | null }>('agents.get_layout');
  const [size, setSize] = useState(4);
  const [order, setOrder] = useState<string[]>([]);
  const [dialog, setDialog] = useState<null | 'new' | { start: Agent | null }>(null);
  const drag = useRef<number | null>(null);

  useEffect(() => { if (layout.data) { setSize(layout.data.size); setOrder(layout.data.order); } }, [layout.data]);
  useEffect(() => {
    const offs = [on('agents.run.updated', (e) => runs.setData((d) => d && { ...d, runs: upsert(d.runs, e.data) })), on('agents.agent.saved', () => agents.reload())];
    const t = setInterval(() => runs.reload(), 15000);
    return () => { offs.forEach((o) => o()); clearInterval(t); };
  }, []);

  const all = runs.data?.runs ?? [];
  // Panels: the saved order first, then the most recent active runs, then the latest finished ones.
  const shown = useMemo(() => {
    const byId = new Map(all.map((r) => [r.id, r]));
    const picked: Run[] = [];
    for (const id of order) { const r = byId.get(id); if (r && !picked.includes(r)) picked.push(r); }
    const rank = (r: Run) => (['needs_you', 'working', 'blocked'].includes(r.status) ? 0 : r.status === 'failed' ? 1 : 2);
    for (const r of [...all].sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at))) if (picked.length < size && !picked.includes(r)) picked.push(r);
    return picked.slice(0, size);
  }, [all, order, size]);

  const save = (s: number, o: string[]) => callTool('agents.save_layout', { size: s, order: o }).catch(err);
  const setLayout = (s: number) => { setSize(s); save(s, shown.map((r) => r.id)); };
  const drop = (to: number) => {
    const from = drag.current;
    drag.current = null;
    if (from === null || from === to) return;
    const ids = shown.map((r) => r.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    setOrder(ids);
    save(size, ids);
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (['TEXTAREA', 'INPUT', 'SELECT'].includes((document.activeElement as HTMLElement)?.tagName) || e.metaKey || e.ctrlKey || e.altKey || dialog) return;
      if (e.key === 'n') { e.preventDefault(); setDialog({ start: null }); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });

  const counts = runs.data?.counts ?? {};
  return (
    <div className="ui-page wos-wide wos-agents">
      <div className="ui-ph">
        <div>
          <h1>Agents</h1>
          <p className="wos-statusline">{(['working', 'needs_you', 'blocked', 'failed', 'done'] as const).map((s) => <span key={s}><Dot status={s} /> {counts[s] ?? 0} {STATUS_LABEL[s].toLowerCase()}</span>)}</p>
        </div>
        <div className="wos-row wos-wrap">
          <div className="ui-seg" aria-label="Panels">{[1, 2, 4, 6].map((n) => <button key={n} type="button" data-tool="agents.save_layout" aria-pressed={size === n} onClick={() => setLayout(n)} aria-label={`${n} panels`}>{n}</button>)}</div>
          <Btn tool="agents.create" variant="quiet" onClick={() => setDialog('new')}><Icon name="plus" size={16} /> New agent</Btn>
          <Btn tool="agents.start" onClick={() => setDialog({ start: null })}><Icon name="play" size={15} /> Start <Kbd>N</Kbd></Btn>
        </div>
      </div>

      {!all.length && !runs.loading ? (
        <Empty icon="agents" title="No agents running" action={<Btn tool="agents.start" onClick={() => setDialog({ start: null })}>Start an agent</Btn>}>Give an agent a goal. It makes a plan, works through it with your apps, asks you when it needs you, and shows real progress here.</Empty>
      ) : (
        <div className="wos-grid" data-size={size}>
          {shown.map((r, i) => (
            <div key={r.id} className="wos-grid-cell" draggable onDragStart={() => { drag.current = i; }} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(i)}>
              <Panel run={r} onFocus={() => navigate(`/run/${r.id}`)} compact={size >= 4} />
            </div>
          ))}
        </div>
      )}

      <h2 className="wos-h2 wos-gap-top">Saved agents</h2>
      <div className="wos-cards wos-cards-3">
        {(agents.data?.agents ?? []).filter((a) => !a.id.startsWith('ext_')).map((a) => (
          <div key={a.id} className="ui-card wos-agentcard">
            <div className="wos-row wos-between"><b>{a.name}</b>{a.last_run && <Dot status={a.last_run.status} label />}</div>
            <p>{a.role}</p>
            <div className="wos-row wos-between">
              <small className="wos-muted">{a.model ?? (a.provider_id === 'demo' ? 'Demo model' : 'Default model')} · {a.scopes.join(', ')}</small>
              <span className="wos-row">
                <Btn tool="agents.archive" size="sm" variant="ghost" onClick={async () => { await callTool('agents.archive', { agent_id: a.id }).catch(err); agents.reload(); }}>Archive</Btn>
                <Btn tool="agents.start" size="sm" variant="quiet" onClick={() => setDialog({ start: a })}>Start</Btn>
              </span>
            </div>
          </div>
        ))}
        <button type="button" className="ui-card wos-addcard" data-tool="agents.create" onClick={() => setDialog('new')}><Icon name="plus" /> New agent</button>
      </div>

      {dialog === 'new' && <NewAgent onClose={() => setDialog(null)} onSaved={() => { agents.reload(); setDialog(null); }} />}
      {dialog && dialog !== 'new' && <StartRun agents={(agents.data?.agents ?? []).filter((a) => !a.id.startsWith('ext_'))} preset={dialog.start} onClose={() => setDialog(null)} onStarted={(r) => { setDialog(null); runs.reload(); setOrder((o) => [r.id, ...o.filter((x) => x !== r.id)]); }} />}
    </div>
  );
}

const upsert = (list: Run[], r: Run) => (list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [r, ...list]);

/** One live agent: status, real progress, current step, what it is doing, a box to talk to it. */
function Panel({ run, onFocus, compact }: { run: Run; onFocus?: () => void; compact?: boolean }) {
  const detail = useTool<Run & { events: Ev[]; steps: any[] }>('agents.get_run', { run_id: run.id, events: compact ? 14 : 40 });
  const [events, setEvents] = useState<Ev[]>([]);
  const [msg, setMsg] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  useEffect(() => { if (detail.data) setEvents(detail.data.events); }, [detail.data]);
  useEffect(() => on('agents.run.event', (e) => { if (e.data.run_id === run.id) setEvents((x) => [...x.slice(-60), e.data]); }), [run.id]);
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight }); }, [events.length]);

  const act = (tool: string) => callTool(tool, { run_id: run.id }).catch(err);
  const send = async () => { const t = msg.trim(); if (!t) return; setMsg(''); await callTool('agents.message', { run_id: run.id, text: t }).catch(err); };
  const ended = run.status === 'done' || run.status === 'failed';
  return (
    <article className="wos-panel ui-card" data-status={run.status} aria-label={`${run.agent_name}: ${STATUS_LABEL[run.status]}`}>
      <header className="wos-panel-h">
        <Dot status={run.status} />
        <b className="wos-clip">{run.agent_name}</b>
        <small className="wos-muted wos-clip">{STATUS_LABEL[run.status]}{run.model ? ` · ${run.model}` : ''}</small>
        {onFocus && <Btn tool="none" why="opens the run full screen" variant="ghost" size="sm" icon aria-label="Focus" onClick={onFocus}><Icon name="expand" size={15} /></Btn>}
      </header>
      <p className="wos-goal">{run.goal}</p>
      {run.task_ref?.startsWith('board:') && <a className="wos-task-ref wos-muted" href={`/a/board/t/${run.task_ref.slice(6).split(' ')[0]}`} data-tool="none" data-why="opens the board task" onClick={(e) => { e.preventDefault(); history.pushState(null, '', e.currentTarget.getAttribute('href')); dispatchEvent(new PopStateEvent('popstate')); }}>Board task: {run.task_ref.slice(6).split(' ').slice(1).join(' ') || run.task_ref.slice(6)}</a>}
      <Progress run={run} />
      <div className="wos-feed" ref={feed}>
        {events.filter(visible).map((e) => <Line key={e.id} e={e} />)}
        {!events.length && <p className="wos-muted">Starting.</p>}
      </div>
      {run.status === 'needs_you' && <a className="wos-needs" href={`/inbox${run.waiting_alert_id ? `?alert=${run.waiting_alert_id}` : ''}`} data-tool="none" data-why="opens the inbox" onClick={(e) => { e.preventDefault(); history.pushState(null, '', e.currentTarget.getAttribute('href')); dispatchEvent(new PopStateEvent('popstate')); }}>{run.status_note ?? 'Waiting for you'}: answer in the inbox</a>}
      {run.status !== 'needs_you' && run.status_note && run.status !== 'working' && <p className="wos-note">{run.status_note}</p>}
      <footer className="wos-panel-f">
        {!ended && run.runtime !== 'external' && (
          <form className="wos-panel-msg" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input className="ui-input" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Tell it something" aria-label={`Message ${run.agent_name}`} />
            <button className="ui-send" type="submit" data-tool="agents.message" aria-label="Send" disabled={!msg.trim()}><Icon name="send" size={15} /></button>
          </form>
        )}
        <div className="wos-row wos-panel-actions">
          {run.status === 'working' && <Btn tool="agents.pause" size="sm" variant="ghost" onClick={() => act('agents.pause')}><Icon name="pause" size={14} /> Pause</Btn>}
          {run.status === 'idle' && <Btn tool="agents.resume" size="sm" variant="ghost" onClick={() => act('agents.resume')}><Icon name="play" size={14} /> Resume</Btn>}
          {['failed', 'blocked'].includes(run.status) && <Btn tool="agents.retry" size="sm" variant="ghost" onClick={() => act('agents.retry')}><Icon name="retry" size={14} /> Retry</Btn>}
          {!ended && run.status !== 'idle' && <Btn tool="agents.stop" size="sm" variant="ghost" onClick={() => act('agents.stop')}><Icon name="stop" size={13} /> Stop</Btn>}
          <small className="wos-muted wos-push">{ended ? `ended ${ago(run.ended_at)}` : `started ${ago(run.started_at)}`}</small>
        </div>
      </footer>
    </article>
  );
}

/** Percent from the plan only. No plan, no percent: then the panel shows time and spend. */
function Progress({ run }: { run: Run }) {
  return (
    <div className="wos-progress">
      {run.percent === null ? (
        <div className="wos-row wos-between"><small className="wos-muted">No plan yet</small><small className="wos-muted">{run.spend.turns} turns · {fmtTokens(run.spend.tokens)}</small></div>
      ) : (
        <>
          <div className="wos-row wos-between">
            <small><b>{run.percent}%</b> · {run.steps_done} of {run.steps_total} steps</small>
            <small className="wos-muted">{run.current_step && run.status !== 'done' ? `Step ${run.current_step.n}: ${run.current_step.text}` : ''}</small>
          </div>
          <div className="wos-bar" role="progressbar" aria-valuenow={run.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Plan progress"><i style={{ width: `${run.percent}%` }} /></div>
        </>
      )}
      {run.plan_note && <small className="wos-plan-note">{run.plan_note}</small>}
      <div className="wos-budget" title={`Budget used: ${run.spend.percent}% (${run.spend.turns} of ${run.spend.budget_turns} turns, ${fmtTokens(run.spend.tokens)} of ${fmtTokens(run.spend.budget_tokens)})`} role="meter" aria-valuenow={run.spend.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used"><i style={{ width: `${run.spend.percent}%` }} /></div>
    </div>
  );
}

const fmtTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k tokens` : `${n} tokens`);

function Line({ e }: { e: Ev }) {
  const p = e.payload ?? {};
  let body: ReactNode;
  switch (e.kind) {
    case 'message': body = <span>{p.text}</span>; break;
    case 'tool_call': body = <span className="ui-tool wos-tool-line"><b>{p.name}</b><span>{summarise(p.input)}</span></span>; break;
    case 'tool_result': body = <span className={`wos-muted${p.error ? ' wos-warn' : ''}`}>{p.error ? 'Error: ' : '↳ '}{String(p.output).slice(0, 160)}</span>; break;
    case 'plan': body = <span><b>Plan</b>{p.note ? ` (${p.note})` : ''}: {p.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('  ')}</span>; break;
    case 'step_done': body = <span>✓ Step {p.n}: {p.text} <small className="wos-muted">· {String(p.evidence).slice(0, 100)}</small></span>; break;
    case 'ask': body = <span><b>Asked:</b> {p.question}</span>; break;
    case 'answer': body = <span><b>You:</b> {String(p.output).replace(/^The person answered: /, '')}</span>; break;
    case 'approval': body = <span><b>Needs approval:</b> {p.tool}</span>; break;
    case 'person_message': body = <span><b>{p.by}:</b> {p.text}</span>; break;
    case 'status': body = <span className="wos-muted">{p.note ?? STATUS_LABEL[p.status]}</span>; break;
    default: body = <span className="wos-muted">{e.kind}</span>;
  }
  return <div className={`wos-line is-${e.kind}`}>{body}</div>;
}

// The plan and step lines already say what the agent's own bookkeeping calls did.
const OWN = new Set(['agents.set_plan', 'agents.complete_step', 'agents.ask']);
const visible = (e: Ev) => !((e.kind === 'tool_call' || e.kind === 'tool_result') && OWN.has(e.payload?.name)) && (e.kind !== 'status' || e.payload?.note);

const summarise = (i: any) => (i && typeof i === 'object' ? Object.entries(i).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ').slice(0, 100) : '');

function Focus({ runId, navigate }: { runId: string; navigate: (p: string) => void }) {
  const d = useTool<Run & { steps: { n: number; text: string; done_at: string | null; evidence: string | null }[]; events: Ev[] }>('agents.get_run', { run_id: runId, events: 0 });
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => { if (d.data) setRun(d.data); }, [d.data]);
  useEffect(() => on('agents.run.updated', (e) => { if (e.data.id === runId) { setRun(e.data); d.reload(); } }), [runId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !['TEXTAREA', 'INPUT'].includes((document.activeElement as HTMLElement)?.tagName)) navigate('/'); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  if (!run) return <div className="ui-page" aria-busy="true" />;
  return (
    <div className="ui-page wos-wide">
      <div className="ui-crumbs"><a href="/agents" data-tool="none" data-why="navigation" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Agents</a> / {run.agent_name} <Kbd>Esc</Kbd></div>
      <div className="wos-focus">
        <Panel run={run} />
        <section className="ui-card">
          <h2 className="wos-h2">Plan</h2>
          {d.data?.steps.length ? (
            <ul className="ui-checks">{d.data.steps.map((s) => <li key={s.n} className={s.done_at ? '' : 'is-open'}><b>{s.n}. {s.text}</b>{s.evidence && <small className="wos-evidence">Evidence: {s.evidence}</small>}</li>)}</ul>
          ) : <p className="wos-muted">No plan yet, so no percent. The agent publishes one with agents.set_plan.</p>}
          <dl className="ui-kv wos-gap-top">
            <dt>Status</dt><dd><Dot status={run.status} label /></dd>
            <dt>Started</dt><dd>{ago(run.started_at)}</dd>
            <dt>Spend</dt><dd>{run.spend.turns} of {run.spend.budget_turns} turns · {fmtTokens(run.spend.tokens)}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

function NewAgent({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const models = useTool<any>('models.list_providers');
  const [f, setF] = useState({ name: '', role: '', provider: '', write: true, del: false, turns: 40 });
  useEffect(() => { ref.current?.showModal(); }, []);
  const save = async () => {
    const [provider_id, model] = f.provider ? f.provider.split('|') : [];
    await callTool('agents.create', { name: f.name, role: f.role, provider_id: provider_id || undefined, model: model || undefined, scopes: ['read', ...(f.write ? ['write'] : []), ...(f.del ? ['delete'] : [])], budget: { max_turns: Number(f.turns) } }).then(onSaved).catch(err);
  };
  return (
    <dialog ref={ref} className="ui-dialog" onClose={onClose}>
      <div className="ui-dialog-h"><h3>New agent</h3><button className="ui-x" data-tool="none" data-why="closes the dialog" onClick={() => ref.current?.close()} aria-label="Close">×</button></div>
      <form className="ui-dialog-b" id="new-agent" data-tool="agents.create" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="ui-fields">
          <label className="ui-field"><span>Name</span><input className="ui-input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Researcher" required /></label>
          <label className="ui-field"><span>Model</span>
            <select className="ui-select" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} data-tool="none" data-why="part of the new agent form">
              <option value="">Your default</option>
              {(models.data?.providers ?? []).map((p: any) => (p.models.length ? p.models : [{ id: p.default_model, name: p.default_model }]).slice(0, 8).map((m: any) => <option key={`${p.id}|${m.id}`} value={`${p.id}|${m.id}`}>{p.name}: {m.name}</option>))}
            </select>
          </label>
          <label className="ui-field is-wide"><span>Role <small>what it is for and how it should work</small></span><textarea className="ui-textarea" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="Finds and checks facts about our clients, then writes short summaries with sources." required /></label>
          <div className="ui-field"><span>It may</span>
            <label className="ui-check"><input type="checkbox" checked disabled data-tool="none" data-why="part of the new agent form" /> Look things up</label>
            <label className="ui-check"><input type="checkbox" checked={f.write} onChange={(e) => setF({ ...f, write: e.target.checked })} data-tool="none" data-why="part of the new agent form" /> Create and change things</label>
            <label className="ui-check"><input type="checkbox" checked={f.del} onChange={(e) => setF({ ...f, del: e.target.checked })} data-tool="none" data-why="part of the new agent form" /> Delete things</label>
          </div>
          <label className="ui-field"><span>Budget <small>turns before it stops</small></span><input className="ui-input" type="number" min={1} max={500} value={f.turns} onChange={(e) => setF({ ...f, turns: Number(e.target.value) })} /></label>
        </div>
        <p className="ui-hint">It never gets more access than the person who starts it. Sending, deleting for everyone or paying always asks you first.</p>
      </form>
      <div className="ui-dialog-a">
        <Btn tool="none" why="closes the dialog" variant="quiet" onClick={() => ref.current?.close()}>Cancel</Btn>
        <Btn tool="agents.create" type="submit" form="new-agent" disabled={!f.name.trim() || !f.role.trim()}>Save agent</Btn>
      </div>
    </dialog>
  );
}

function StartRun({ agents, preset, onClose, onStarted }: { agents: Agent[]; preset: Agent | null; onClose: () => void; onStarted: (r: Run) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [agentId, setAgentId] = useState(preset?.id ?? agents[0]?.id ?? '');
  const [goal, setGoal] = useState('');
  // Board tasks to work on, when the board is on (an off board throws no_tool and the field stays hidden).
  const [tasks, setTasks] = useState<{ id: string; title: string }[]>([]);
  const [task, setTask] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    callTool<any>('board.find_tasks', {}).then((r) => {
      const text = String(r?.result ?? '');
      setTasks([...text.matchAll(/\*\*(.+?)\*\*.*?id `([^`]+)`/g)].map((m) => ({ title: m[1], id: m[2] })));
    }).catch(() => {});
  }, []);
  const picked = tasks.find((t) => t.id === task);
  const goalText = goal.trim() || (picked ? `Work on the board task "${picked.title}"` : '');
  const go = async () => { const r = await callTool('agents.start', { agent_id: agentId, goal: goalText, ...(picked ? { task_ref: `board:${picked.id} ${picked.title}` } : {}) }).catch(err); if (r) onStarted(r); };
  return (
    <dialog ref={ref} className="ui-dialog" onClose={onClose}>
      <div className="ui-dialog-h"><h3>Start an agent</h3><button className="ui-x" data-tool="none" data-why="closes the dialog" onClick={() => ref.current?.close()} aria-label="Close">×</button></div>
      <form className="ui-dialog-b" id="start-run" data-tool="agents.start" onSubmit={(e) => { e.preventDefault(); go(); }}>
        {agents.length ? (
          <>
            <label className="ui-field"><span>Agent</span><select className="ui-select" value={agentId} onChange={(e) => setAgentId(e.target.value)} data-tool="none" data-why="part of the start form">{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            {tasks.length > 0 && <label className="ui-field"><span>Board task <small>optional</small></span><select className="ui-select" value={task} onChange={(e) => setTask(e.target.value)} data-tool="none" data-why="part of the start form"><option value="">None</option>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>}
            <label className="ui-field"><span>Goal</span><textarea className="ui-textarea" autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); }} placeholder={picked ? `Work on the board task "${picked.title}"` : 'Find 20 dental clinics in Ohio and add them to the CRM'} /></label>
          </>
        ) : <p>Save an agent first.</p>}
      </form>
      <div className="ui-dialog-a">
        <Btn tool="none" why="closes the dialog" variant="quiet" onClick={() => ref.current?.close()}>Cancel</Btn>
        <Btn tool="agents.start" type="submit" form="start-run" disabled={!agentId || goalText.length < 3}>Start</Btn>
      </div>
    </dialog>
  );
}
