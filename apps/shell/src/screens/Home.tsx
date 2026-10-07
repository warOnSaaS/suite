// Home is a conversation, like the Claude and ChatGPT apps: ask, and the assistant uses every app that is on.
import { useEffect, useRef, useState, Fragment } from 'react';
import { callTool, on, ToolError } from '../api.ts';
import { navigate, linkProps } from '../router.ts';
import { Btn, Icon, useTool, toast } from '../kit.tsx';
import { useShell } from '../App.tsx';
import { Markdown } from '../markdown.tsx';

interface Msg { id: string; role: 'user' | 'assistant' | 'tool'; text?: string; tools?: { name: string }[]; results?: { name: string; error: boolean; output: string }[] }
interface Providers { providers: { id: string; kind: string; name: string; models: { id: string; name: string }[]; default_model: string | null }[]; default: { provider_id: string; model: string } }

const PROMPTS = ['What needs me today?', 'Show the open deals in the CRM', 'What is on the board this week?', 'Start an agent to research our biggest deals'];

export function Home({ conversationId }: { conversationId: string | null }) {
  const { me, apps } = useShell();
  const conv = useTool<{ id: string; title: string; provider_id: string; model: string; messages: Msg[] }>(conversationId ? 'conversations.get' : null, { conversation_id: conversationId });
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [stream, setStream] = useState('');
  const [toolNow, setToolNow] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ provider_id: string; model: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (conv.data) { setMessages(conv.data.messages); if (conv.data.provider_id) setChoice({ provider_id: conv.data.provider_id, model: conv.data.model }); } }, [conv.data]);
  useEffect(() => {
    const offs = [
      on('conversations.message.delta', (e) => { if (!conversationId || e.data.conversation_id === conversationId) setStream((s) => s + e.data.text); }),
      on('conversations.tool.called', (e) => { if (!conversationId || e.data.conversation_id === conversationId) setToolNow(e.data.name); }),
    ];
    return () => offs.forEach((o) => o());
  }, [conversationId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length, stream]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === '/' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); inputRef.current?.focus(); } };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);

  const send = async (t = text) => {
    const body = t.trim();
    if (!body || sending) return;
    setText('');
    setSending(true);
    setStream('');
    setToolNow(null);
    setMessages((m) => [...m, { id: `tmp${Date.now()}`, role: 'user', text: body }]);
    try {
      const r = await callTool('conversations.send', { conversation_id: conversationId ?? undefined, text: body, ...(choice ?? {}) });
      if (!conversationId) navigate(`/c/${r.conversation_id}`, true);
      else await conv.reload();
    } catch (e: any) {
      toast(e instanceof ToolError ? e.message : 'Could not send. Try again.');
      setMessages((m) => [...m, { id: `err${Date.now()}`, role: 'assistant', text: `Could not answer: ${e.message}` }]);
    } finally {
      setSending(false);
      setStream('');
      setToolNow(null);
    }
  };

  const empty = !conversationId && !messages.length;
  const composer = (
    <form className="ui-composer wos-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <textarea ref={inputRef} rows={1} value={text} autoFocus={empty} placeholder={empty ? 'Ask anything, or tell an agent what to do' : 'Reply'} aria-label="Message"
        onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`; }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
      <div className="wos-composer-bar">
        <ModelPicker value={choice} onChange={setChoice} />
        <button className="ui-send" type="submit" data-tool="conversations.send" aria-label="Send" disabled={!text.trim() || sending}><Icon name="send" size={17} /></button>
      </div>
    </form>
  );

  if (empty) {
    const first = me.user.name.split(' ')[0].replace(/\(.*/, '').trim();
    return (
      <div className="wos-home">
        <div className="wos-home-in">
          <h1>What should we get done{first ? `, ${first}` : ''}?</h1>
          <p className="wos-lede">Ask about anything in {apps.filter((a) => a.on && !a.core).map((a) => a.name).join(', ') || 'your apps'}, or put an agent on it.</p>
          {composer}
          <div className="ui-prompts wos-prompts">
            {PROMPTS.map((p) => <button key={p} type="button" data-tool="conversations.send" onClick={() => send(p)}>{p}</button>)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wos-conv">
      <div className="wos-thread" aria-live="polite">
        {conv.data?.title && <div className="wos-conv-title">{conv.data.title}</div>}
        {messages.map((m) => <Fragment key={m.id}>{render(m)}</Fragment>)}
        {sending && (
          <div className="ui-ai">
            <span className="ui-av">w</span>
            <div className="ui-body">
              {toolNow && <div className="ui-tool"><b>{toolNow}</b><span>using the tool</span></div>}
              {stream ? <Markdown text={stream} /> : <div className="ui-thinking"><i /><span>Thinking</span></div>}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="wos-conv-foot">{composer}</div>
    </div>
  );
}

function render(m: Msg) {
  if (m.role === 'user') return <div className="ui-you"><p>{m.text}</p></div>;
  if (m.role === 'tool') return <div className="wos-results">{m.results?.map((r, i) => <details key={i} className="wos-result"><summary className="ui-tool"><b>{r.name}</b><span>{r.error ? 'failed' : 'result'}</span></summary><pre>{r.output}</pre></details>)}</div>;
  return (
    <div className="ui-ai">
      <span className="ui-av">w</span>
      <div className="ui-body">
        {m.text && <Markdown text={m.text} />}
        {m.tools?.map((t, i) => <div key={i} className="ui-tool"><b>{t.name}</b><span>called</span></div>)}
      </div>
    </div>
  );
}

export function ModelPicker({ value, onChange }: { value: { provider_id: string; model: string } | null; onChange: (v: { provider_id: string; model: string }) => void }) {
  const list = useTool<Providers>('models.list_providers');
  const [open, setOpen] = useState(false);
  const cur = value ?? list.data?.default ?? null;
  const prov = list.data?.providers.find((p) => p.id === cur?.provider_id);
  const label = prov ? `${prov.models.find((m) => m.id === cur?.model)?.name ?? cur?.model ?? ''}` : 'Model';
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.wos-picker')) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', close);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); };
  }, [open]);
  const makeDefault = async (provider_id: string, model: string) => { await callTool('models.set_default', { provider_id, model }); toast('Default model saved'); list.reload(); };
  return (
    <div className="wos-picker">
      <button type="button" className="wos-picker-btn" data-tool="none" data-why="opens the model menu" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="model" size={15} /><span className="wos-clip">{label}</span><Icon name="chevron" size={14} />
      </button>
      {open && list.data && (
        <div className="wos-menu" role="listbox">
          {list.data.providers.map((p) => (
            <div key={p.id} className="wos-menu-group">
              <div className="ui-label">{p.name}</div>
              {(p.models.length ? p.models : [{ id: p.default_model ?? '', name: p.default_model ?? 'Default' }]).slice(0, 12).map((m) => (
                <div key={m.id} className="wos-menu-row">
                  <button type="button" role="option" aria-selected={cur?.provider_id === p.id && cur?.model === m.id} data-tool="none" data-why="chooses the model for the next message" onClick={() => { onChange({ provider_id: p.id, model: m.id }); setOpen(false); }}>
                    {m.name}
                  </button>
                  {list.data!.default.provider_id === p.id && list.data!.default.model === m.id ? <small>default</small> : <button type="button" className="wos-link" data-tool="models.set_default" onClick={() => makeDefault(p.id, m.id)}>Make default</button>}
                </div>
              ))}
            </div>
          ))}
          <a className="wos-menu-add" {...linkProps('/settings/models')} onClick={(e) => { e.preventDefault(); setOpen(false); navigate('/settings/models'); }}><Icon name="plus" size={15} /> Add a model</a>
        </div>
      )}
    </div>
  );
}
