// One inbox for every agent's questions, approvals and finished work. Keyboard first, like getone.one:
// J and K move, 1 2 3 answer, E clears, Enter writes your own answer, Escape undoes within two seconds.
import { useEffect, useMemo, useRef, useState } from 'react';
import { callTool, on } from '../api.ts';
import { Btn, Dot, Empty, Icon, Kbd, ago, toast, useTool } from '../kit.tsx';
import { linkProps } from '../router.ts';
import { Page } from '../App.tsx';

interface Alert { id: string; kind: string; title: string; body: string | null; options: string[]; ref: any; source: string | null; status: string; answer: string | null; answered_via: string | null; created_at: string }
const KIND_STATUS: Record<string, string> = { approval: 'needs_you', question: 'needs_you', blocked: 'blocked', failed: 'failed', done: 'done' };
const KIND_LABEL: Record<string, string> = { approval: 'Approval', question: 'Question', blocked: 'Blocked', failed: 'Failed', done: 'Done' };
const UNDO_MS = 2000;

export function Inbox() {
  const [status, setStatus] = useState<'open' | 'answered'>('open');
  const list = useTool<{ open: number; alerts: Alert[] }>('alerts.list', { status, limit: 100 });
  const [sel, setSel] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ id: string; label: string; run: () => Promise<unknown> } | null>(null);
  const [reply, setReply] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => on('alerts.*', () => list.reload()), [status]);
  const alerts = useMemo(() => (list.data?.alerts ?? []).filter((a) => !hidden.has(a.id)), [list.data, hidden]);
  const want = new URLSearchParams(location.search).get('alert');
  useEffect(() => { if (want && alerts.length) { const i = alerts.findIndex((a) => a.id === want); if (i >= 0) setSel(i); } }, [want, list.data]);
  const cur = alerts[Math.min(sel, alerts.length - 1)];

  // Every answer waits two seconds before it is sent, so Escape can take it back.
  const later = (a: Alert, label: string, run: () => Promise<unknown>) => {
    if (pending) flush();
    setHidden((h) => new Set(h).add(a.id));
    setPending({ id: a.id, label, run });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      setPending(null);
      try { await run(); } catch (e: any) { toast(e.message); setHidden((h) => { const n = new Set(h); n.delete(a.id); return n; }); }
      list.reload();
    }, UNDO_MS);
  };
  const flush = () => { if (!pending) return; clearTimeout(timer.current); const p = pending; setPending(null); p.run().then(() => list.reload()).catch((e) => toast(e.message)); };
  const undo = () => { if (!pending) return; clearTimeout(timer.current); setHidden((h) => { const n = new Set(h); n.delete(pending.id); return n; }); setPending(null); toast('Undone'); };

  const answer = (a: Alert, option: number) => { if (a.options[option] === undefined || status !== 'open') return; later(a, `Answered "${a.options[option]}"`, () => callTool('alerts.answer', { alert_id: a.id, option })); };
  const clear = (a: Alert) => { if (status !== 'open') return; later(a, 'Cleared', () => callTool('alerts.clear', { alert_id: a.id })); };
  const sendReply = (a: Alert) => { const t = reply.trim(); if (!t) return; setReply(''); later(a, 'Replied', () => callTool('alerts.answer', { alert_id: a.id, text: t })); };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes((document.activeElement as HTMLElement)?.tagName);
      if (e.key === 'Escape') { if (pending) { e.preventDefault(); undo(); } else if (typing) (document.activeElement as HTMLElement).blur(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(alerts.length - 1, s + 1)); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      else if (cur && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); answer(cur, Number(e.key) - 1); }
      else if (cur && e.key === 'e') { e.preventDefault(); clear(cur); }
      else if (cur && e.key === 'Enter') { e.preventDefault(); replyRef.current?.focus(); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });
  useEffect(() => { if (sel >= alerts.length && alerts.length) setSel(alerts.length - 1); }, [alerts.length]);

  return (
    <Page title="Inbox" sub="Questions, approvals and finished work from your agents and apps." wide
      actions={<div className="ui-seg" role="tablist">{(['open', 'answered'] as const).map((s) => <button key={s} type="button" role="tab" data-tool="alerts.list" aria-pressed={status === s} onClick={() => { setStatus(s); setSel(0); }}>{s === 'open' ? `Open${list.data && status === 'open' ? ` ${alerts.length}` : ''}` : 'Answered'}</button>)}</div>}>
      {pending && (
        <div className="wos-undo" role="status">
          <span>{pending.label}</span>
          <button type="button" className="wos-link" data-tool="none" data-why="takes back the answer before it is sent" onClick={undo}>Undo <Kbd>Esc</Kbd></button>
          <i className="wos-undo-bar" style={{ animationDuration: `${UNDO_MS}ms` }} />
        </div>
      )}
      {!alerts.length && !list.loading ? (
        <Empty icon="inbox" title={status === 'open' ? 'Nothing needs you' : 'Nothing answered yet'}>{status === 'open' ? 'When an agent asks a question, needs an approval or finishes, it lands here and on your phone.' : 'Answered alerts show here.'}</Empty>
      ) : (
        <div className="wos-inbox">
          <ul className="wos-inbox-list" role="listbox" aria-label="Alerts">
            {alerts.map((a, i) => (
              <li key={a.id} role="option" aria-selected={a === cur} className={a === cur ? 'is-sel' : ''} data-tool="none" data-why="selects the alert" onClick={() => setSel(i)}>
                <Dot status={KIND_STATUS[a.kind] ?? 'idle'} />
                <span className="wos-inbox-t"><b>{a.title}</b><small>{KIND_LABEL[a.kind] ?? a.kind} · {ago(a.created_at)}{a.answer ? ` · ${a.answer}` : ''}</small></span>
              </li>
            ))}
          </ul>
          {cur && (
            <section className="wos-inbox-detail ui-card" aria-label="Alert">
              <div className="wos-row wos-between"><span className="ui-chip" data-tone={cur.kind === 'failed' ? '4' : cur.kind === 'done' ? '5' : '3'}>{KIND_LABEL[cur.kind] ?? cur.kind}</span><small className="wos-muted">{ago(cur.created_at)}{cur.source ? ` · ${cur.source}` : ''}</small></div>
              <h2>{cur.title}</h2>
              {cur.body && <p className="wos-pre">{cur.body}</p>}
              {cur.ref?.run_id && <a className="wos-link" {...linkProps(`/agents/run/${cur.ref.run_id}`)}>Open the run</a>}
              {status === 'open' ? (
                <>
                  {cur.options.length > 0 && (
                    <div className="wos-answers">
                      {cur.options.map((o, i) => <Btn key={i} tool="alerts.answer" variant={i ? 'quiet' : ''} onClick={() => answer(cur, i)}><Kbd>{i + 1}</Kbd> {o}</Btn>)}
                    </div>
                  )}
                  {cur.kind !== 'approval' && (
                    <form className="wos-reply" onSubmit={(e) => { e.preventDefault(); sendReply(cur); }}>
                      <textarea ref={replyRef} className="ui-textarea" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Or write your own answer" aria-label="Your answer"
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(cur); } }} />
                      <Btn tool="alerts.answer" type="submit" variant="quiet" disabled={!reply.trim()}>Send</Btn>
                    </form>
                  )}
                  <div className="wos-row wos-between wos-foot">
                    <Btn tool="alerts.clear" variant="ghost" size="sm" onClick={() => clear(cur)}><Kbd>E</Kbd> Clear</Btn>
                    <span className="wos-keys"><Kbd>J</Kbd><Kbd>K</Kbd> move · <Kbd>Esc</Kbd> undo</span>
                  </div>
                </>
              ) : (
                <p className="wos-muted">Answered {cur.answer ? `"${cur.answer}"` : ''}{cur.answered_via ? ` by ${cur.answered_via}` : ''}.</p>
              )}
            </section>
          )}
        </div>
      )}
      {list.error && <p className="ui-notice is-quiet"><Icon name="bell" /> {list.error}</p>}
    </Page>
  );
}
