// The shell: a left rail with only the apps that are on, a conversation home, the inbox, settings,
// and each app's screens, fetched only when the app is on and opened.
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { callTool, on, setTeam, startLive } from './api.ts';
import { usePath, linkProps, navigate } from './router.ts';
import { Icon, Btn, Dot, useTool, toast } from './kit.tsx';
import { Home } from './screens/Home.tsx';
import { Inbox } from './screens/Inbox.tsx';
import { Settings } from './screens/Settings.tsx';
import { AppView } from './screens/AppView.tsx';

export interface Me { user: { id: string; name: string; email: string | null; github: string | null; avatar_url: string | null }; team: { id: string; slug: string; name: string; role: string; scopes: string[] } | null; teams: { id: string; slug: string; name: string; role: string }[]; server: { demo: boolean; reduced: boolean; storage: string; email: boolean; push: boolean; github: boolean } }
export interface AppInfo { id: string; name: string; description: string; icon: string; order: number; nav: boolean; core: boolean; on: boolean; loaded: boolean; unavailable: string | null; mount: { path: string; start?: string } | null; screens: string | null; needs: any; version: string; tools: number }

interface Shell { me: Me; apps: AppInfo[]; reloadApps: () => void; openAlerts: number; runCounts: Record<string, number>; reloadMe: () => void }
const Ctx = createContext<Shell>(null as any);
export const useShell = () => useContext(Ctx);

export function App() {
  const me = useTool<Me>('account.me');
  if (me.error) return <div className="ui-blank"><b>Could not load wOS</b><p>{me.error}</p></div>;
  if (!me.data) return <div className="wos-boot" aria-busy="true" />;
  if (!me.data.team) return <NoTeam me={me.data} />;
  return <Signed me={me.data} reloadMe={me.reload} />;
}

function Signed({ me, reloadMe }: { me: Me; reloadMe: () => void }) {
  setTeam(me.team!.id);
  const apps = useTool<{ apps: AppInfo[] }>('apps.list');
  const alerts = useTool<{ open: number }>('alerts.list', { limit: 1 });
  const runs = useTool<{ counts: Record<string, number> }>('agents.runs', { limit: 1 });
  const path = usePath();
  const [drawer, setDrawer] = useState(false);

  useEffect(() => { startLive({ socket: !me.server.reduced }); }, []);
  useEffect(() => {
    const offs = [
      on('apps.*', () => apps.reload()),
      on('alerts.*', () => alerts.reload()),
      on('agents.run.updated', () => runs.reload()),
      on('alerts.alert.raised', (e) => notify(e.data)),
    ];
    return () => offs.forEach((o) => o());
  }, []);
  useEffect(() => { setDrawer(false); }, [path]);

  const openAlerts = alerts.data?.open ?? 0;
  const counts = runs.data?.counts ?? {};
  useEffect(() => {
    const busy = counts.needs_you ?? 0;
    document.title = `${openAlerts ? `(${openAlerts}) ` : ''}${busy ? 'Needs you · ' : counts.working ? 'Working · ' : ''}wOS`;
  }, [openAlerts, counts.needs_you, counts.working]);

  const shell = useMemo<Shell>(() => ({ me, apps: apps.data?.apps ?? [], reloadApps: apps.reload, openAlerts, runCounts: counts, reloadMe }), [me, apps.data, openAlerts, runs.data]);
  const onApps = (apps.data?.apps ?? []).filter((a) => a.on && a.nav);

  return (
    <Ctx.Provider value={shell}>
      <div className="ui-shell wos-shell">
        <aside className={`ui-side wos-side${drawer ? ' is-open' : ''}`} aria-label="Main">
          <a className="ui-brand wos-brand" {...linkProps('/')}><span className="wos-logo">wOS</span><small>{me.team!.name}</small></a>
          <Btn tool="none" why="opens a new conversation" variant="quiet" className="wos-new" onClick={() => navigate('/')}><Icon name="plus" size={16} /> New conversation</Btn>
          <nav className="ui-side-nav">
            <a {...linkProps('/inbox')} aria-current={path.startsWith('/inbox') ? 'page' : undefined}><Icon name="inbox" /> Inbox {openAlerts > 0 && <em className="wos-count">{openAlerts}</em>}</a>
            {onApps.map((a) => {
              const to = a.id === 'agents' ? '/agents' : `/a/${a.id}`;
              return (
                <a key={a.id} {...linkProps(to)} aria-current={path.startsWith(to) ? 'page' : undefined}>
                  <Icon name={a.icon} /> {a.name}
                  {a.id === 'agents' && <AgentDots counts={counts} />}
                </a>
              );
            })}
          </nav>
          <History path={path} />
          <div className="ui-side-low">
            <nav className="ui-side-nav"><a {...linkProps('/settings/apps')} aria-current={path.startsWith('/settings') ? 'page' : undefined}><Icon name="settings" /> Settings</a></nav>
            <a className="ui-side-me" {...linkProps('/settings/account')}>
              <Avatar name={me.user.name} url={me.user.avatar_url} />
              <span><b>{me.user.name}</b><small>{me.team!.role}{me.server.demo ? ' · demo' : ''}</small></span>
            </a>
          </div>
        </aside>
        {drawer && <button className="wos-scrim" data-tool="none" data-why="closes the menu" aria-label="Close menu" onClick={() => setDrawer(false)} />}
        <header className="ui-topbar">
          <Btn tool="none" why="opens the menu" variant="ghost" icon aria-label="Menu" onClick={() => setDrawer(true)}><Icon name="menu" /></Btn>
          <a className="ui-brand" {...linkProps('/')}><span className="wos-logo">wOS</span></a>
          <a className="wos-top-status" {...linkProps('/agents')} aria-label="Agents"><AgentDots counts={counts} always /></a>
        </header>
        <main className="ui-main wos-main">
          <Route path={path} apps={apps.data?.apps ?? []} />
        </main>
        <nav className="ui-dock" aria-label="Main">
          <a {...linkProps('/')} aria-current={path === '/' || path.startsWith('/c/') ? 'page' : undefined}><Icon name="chat" /><span>Ask</span></a>
          <a {...linkProps('/agents')} aria-current={path.startsWith('/agents') ? 'page' : undefined}><Icon name="agents" /><span>Agents</span></a>
          <a {...linkProps('/inbox')} aria-current={path.startsWith('/inbox') ? 'page' : undefined}><Icon name="inbox" /><span>Inbox{openAlerts ? ` ${openAlerts}` : ''}</span></a>
          <a {...linkProps('/settings/apps')} aria-current={path.startsWith('/settings') ? 'page' : undefined}><Icon name="settings" /><span>Settings</span></a>
        </nav>
      </div>
    </Ctx.Provider>
  );
}

function Route({ path, apps }: { path: string; apps: AppInfo[] }) {
  const p = path.split('?')[0];
  if (p === '/' || p.startsWith('/c/')) return <Home key={p.startsWith('/c/') ? 'conv' : 'new'} conversationId={p.startsWith('/c/') ? p.slice(3) : null} />;
  if (p.startsWith('/inbox')) return <Inbox />;
  if (p.startsWith('/settings')) return <Settings tab={p.split('/')[2] || 'apps'} />;
  if (p.startsWith('/agents')) return <AppView app={apps.find((a) => a.id === 'agents')} sub={p.slice('/agents'.length) || '/'} />;
  if (p.startsWith('/a/')) {
    const id = p.split('/')[2];
    return <AppView app={apps.find((a) => a.id === id)} sub={p.slice(`/a/${id}`.length) || '/'} />;
  }
  return <Home key="new" conversationId={null} />;
}

function History({ path }: { path: string }) {
  const list = useTool<{ conversations: { id: string; title: string; updated_at: string }[] }>('conversations.list', { limit: 15 });
  useEffect(() => on('conversations.message.created', () => list.reload()), []);
  const items = list.data?.conversations ?? [];
  if (!items.length) return null;
  return (
    <div className="wos-history">
      <div className="ui-label">Recent</div>
      <nav className="ui-side-nav">
        {items.map((c) => <a key={c.id} {...linkProps(`/c/${c.id}`)} aria-current={path === `/c/${c.id}` ? 'page' : undefined}><span className="wos-clip">{c.title}</span></a>)}
      </nav>
    </div>
  );
}

export function AgentDots({ counts, always }: { counts: Record<string, number>; always?: boolean }) {
  const order = ['needs_you', 'working', 'blocked', 'failed'];
  const shown = order.filter((s) => counts[s]);
  if (!shown.length) return always ? <span className="wos-dots"><Dot status="idle" /></span> : null;
  return <span className="wos-dots" title={shown.map((s) => `${counts[s]} ${s.replace('_', ' ')}`).join(', ')}>{shown.map((s) => <span key={s} className="wos-dotn"><Dot status={s} />{counts[s]}</span>)}</span>;
}

export function Avatar({ name, url, size = '' }: { name: string; url?: string | null; size?: string }) {
  const initials = name.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return <span className={`ui-avatar ${size}`}>{url ? <img src={url} alt="" /> : initials}</span>;
}

function notify(a: any) {
  if (!a?.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) { toast(a.title); return; }
  const n = new Notification(a.title, { body: a.body?.slice(0, 160) ?? '', tag: a.id });
  n.onclick = () => { window.focus(); navigate(`/inbox?alert=${a.id}`); };
}

function NoTeam({ me }: { me: Me }) {
  const [name, setName] = useState('');
  const create = async () => { await callTool('team.create', { name }); location.reload(); };
  return (
    <div className="wos-center-page">
      <h1>Hi {me.user.name}</h1>
      <p>You are not on a team yet. Ask an admin for an invite, or start your own.</p>
      <form className="wos-row" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" aria-label="Team name" />
        <Btn tool="team.create" type="submit" disabled={name.trim().length < 2}>Create team</Btn>
      </form>
    </div>
  );
}

export function Page({ title, sub, actions, children, wide }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`ui-page${wide ? ' wos-wide' : ''}`}>
      <div className="ui-ph"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>{actions && <div className="wos-row">{actions}</div>}</div>
      {children}
    </div>
  );
}

export { lazy, Suspense };
