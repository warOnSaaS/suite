// Thin React wrappers over the ui-design kit's classes. No styles of their own.
import { useCallback, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { callTool, ToolError } from './api.ts';

const P: Record<string, ReactNode> = {
  home: <><path d="M4 11.5 12 5l8 6.5" /><path d="M6 10v9h12v-9" /></>,
  chat: <path d="M5 6h14v9H9l-4 3.5z" />,
  agents: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  board: <><rect x="4" y="5" width="4.5" height="14" rx="1" /><rect x="9.75" y="5" width="4.5" height="9" rx="1" /><rect x="15.5" y="5" width="4.5" height="11.5" rx="1" /></>,
  crm: <><circle cx="9" cy="9" r="3" /><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" /><circle cx="17" cy="8" r="2.3" /><path d="M16 13.2c2.3 0 4 1.3 4.6 3.8" /></>,
  inbox: <><path d="M4 13 6.5 5h11L20 13v6H4z" /><path d="M4 13h4.5l1 2h5l1-2H20" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  chevron: <path d="m8 10 4 4 4-4" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  pause: <path d="M9 6v12M15 6v12" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  retry: <><path d="M5 12a7 7 0 1 0 2.2-5.1" /><path d="M5 4v4h4" /></>,
  bell: <><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5h4" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  model: <><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9 9h6v6H9z" /></>,
  key: <><circle cx="8" cy="15" r="3.5" /><path d="m10.5 12.5 8-8M16 7l2.5 2.5" /></>,
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg className="wos-ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name] ?? P.agents}
    </svg>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { tool: string; why?: string; variant?: 'quiet' | 'ghost' | 'accent' | 'danger' | ''; size?: 'sm' | 'lg' | ''; icon?: boolean };

/** Every button names the tool it calls (data-tool), or "none" with a reason when it only moves around the screen. */
export function Btn({ tool, why, variant = '', size = '', icon, className = '', type = 'button', ...rest }: BtnProps) {
  const cls = ['ui-btn', variant && `is-${variant}`, size && `is-${size}`, icon && 'is-icon', className].filter(Boolean).join(' ');
  return <button type={type} className={cls} data-tool={tool} data-why={tool === 'none' ? why ?? 'moves around the screen' : undefined} {...rest} />;
}

export const STATUS_LABEL: Record<string, string> = { working: 'Working', needs_you: 'Needs you', blocked: 'Blocked', failed: 'Failed', done: 'Done', idle: 'Idle' };

export function Dot({ status, label }: { status: string; label?: boolean }) {
  return (
    <span className="wos-status" data-status={status}>
      <span className="wos-dot" aria-hidden="true" />
      {label && <span>{STATUS_LABEL[status] ?? status}</span>}
    </span>
  );
}

/** Load a read tool's result, and reload on demand or when one of `events` arrives. */
export function useTool<T = any>(name: string | null, input: unknown = {}, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!name);
  const key = JSON.stringify(input);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!name) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const r = await callTool<T>(name, JSON.parse(key));
      if (n === seq.current) { setData(r); setError(null); }
    } catch (e: any) {
      if (n === seq.current) setError(e instanceof ToolError ? e.message : String(e.message ?? e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [name, key]);
  useEffect(() => { load(); }, [load, ...deps]);
  return { data, error, loading, reload: load, setData };
}

let toastTimer: number | undefined;
export function toast(message: string) {
  let el = document.getElementById('wos-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wos-toast';
    el.className = 'ui-toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('is-on'), 2600);
}

export function Empty({ icon = 'agents', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-blank">
      <span className="ui-mark-ic"><Icon name={icon} size={22} /></span>
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

export const ago = (iso?: string | null) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 50) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
