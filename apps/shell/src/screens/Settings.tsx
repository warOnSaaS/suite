// Settings: apps on and off, models, team, alerts, account and hosting. Every control calls a tool.
import { useEffect, useRef, useState } from 'react';
import { callTool, on } from '../api.ts';
import { linkProps } from '../router.ts';
import { Btn, Dot, Empty, Icon, ago, toast, useTool } from '../kit.tsx';
import { Page, useShell, Avatar, type AppInfo } from '../App.tsx';

const TABS = [['apps', 'Apps'], ['models', 'Models'], ['team', 'Team'], ['alerts', 'Alerts'], ['account', 'Account'], ['hosting', 'Hosting']] as const;

export function Settings({ tab }: { tab: string }) {
  return (
    <Page title="Settings">
      <nav className="ui-tabs wos-tabs">{TABS.map(([id, label]) => <a key={id} {...linkProps(`/settings/${id}`)} aria-current={tab === id ? 'page' : undefined}>{label}</a>)}</nav>
      <div className="wos-tab">
        {tab === 'apps' && <Apps />}
        {tab === 'models' && <Models />}
        {tab === 'team' && <Team />}
        {tab === 'alerts' && <Alerts />}
        {tab === 'account' && <Account />}
        {tab === 'hosting' && <Hosting />}
      </div>
    </Page>
  );
}

const err = (e: any) => toast(e.message ?? 'Something went wrong.');
const admin = (scopes: string[]) => scopes.includes('admin');

// ---------- apps ----------

function Apps() {
  const { apps, reloadApps, me } = useShell();
  const [busy, setBusy] = useState<string | null>(null);
  const [remove, setRemove] = useState<AppInfo | null>(null);
  const toggle = async (a: AppInfo) => {
    setBusy(a.id);
    try { await callTool(a.on ? 'apps.disable' : 'apps.enable', { app: a.id }); toast(`${a.name} is ${a.on ? 'off' : 'on'}`); reloadApps(); } catch (e) { err(e); } finally { setBusy(null); }
  };
  return (
    <>
      <p className="wos-muted">Turn an app off and it is not loaded at all: its tools leave the catalogue, its screens are never downloaded, and its data waits until you turn it on again.</p>
      <div className="wos-cards">
        {apps.map((a) => (
          <div key={a.id} className="ui-card wos-appcard">
            <div className="wos-row wos-between">
              <span className="wos-row"><span className="ui-mark-ic wos-ic-sm"><Icon name={a.icon} /></span><b>{a.name}</b>{a.core && <span className="ui-chip is-outline">part of wOS</span>}</span>
              {!a.core && (
                <label className="wos-switch">
                  <input type="checkbox" role="switch" checked={a.on} disabled={!admin(me.team!.scopes) || busy === a.id || (!!a.unavailable && !a.on)} data-tool={a.on ? 'apps.disable' : 'apps.enable'} onChange={() => toggle(a)} aria-label={`${a.name} ${a.on ? 'on' : 'off'}`} />
                  <span>{a.on ? 'On' : 'Off'}</span>
                </label>
              )}
            </div>
            <p>{a.description}</p>
            <div className="wos-row wos-meta">
              <small>{a.tools} tools · v{a.version}</small>
              {a.needs?.services?.length > 0 && <small>Needs: {a.needs.services.join(', ')}</small>}
              {a.unavailable && <small className="wos-warn">{a.unavailable}</small>}
              {!a.core && admin(me.team!.scopes) && <button type="button" className="wos-link wos-danger" data-tool="apps.uninstall" onClick={() => setRemove(a)}>Uninstall and delete data</button>}
            </div>
          </div>
        ))}
      </div>
      {remove && <Uninstall app={remove} onClose={() => { setRemove(null); reloadApps(); }} />}
    </>
  );
}

function Uninstall({ app, onClose }: { app: AppInfo; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [result, setResult] = useState<any>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const go = async () => {
    try { setResult(await callTool('apps.uninstall', { app: app.id, confirm_name: name })); } catch (e) { err(e); }
  };
  return (
    <dialog ref={ref} className="ui-dialog" onClose={onClose}>
      <div className="ui-dialog-h"><h3>Uninstall {app.name}</h3><button className="ui-x" data-tool="none" data-why="closes the dialog" onClick={() => ref.current?.close()} aria-label="Close">×</button></div>
      <div className="ui-dialog-b">
        {result ? (
          <p>Done. {result.deleted_rows} rows deleted. <a href={result.export_url} data-tool="none" data-why="downloads the export made before deleting">Download the export</a> made first.</p>
        ) : (
          <>
            <p>This turns {app.name} off and deletes this team's data in it for good. An export is made first.</p>
            <label className="ui-field"><span>Type {app.name} to confirm</span><input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          </>
        )}
      </div>
      <div className="ui-dialog-a">
        <Btn tool="none" why="closes the dialog" variant="quiet" onClick={() => ref.current?.close()}>{result ? 'Close' : 'Cancel'}</Btn>
        {!result && <Btn tool="apps.uninstall" variant="danger" disabled={name.toLowerCase() !== app.name.toLowerCase()} onClick={go}>Uninstall</Btn>}
      </div>
    </dialog>
  );
}

// ---------- models ----------

function Models() {
  const { me } = useShell();
  const list = useTool<any>('models.list_providers');
  const [kind, setKind] = useState('anthropic');
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', shared: false });
  const [adding, setAdding] = useState(false);
  const k = list.data?.kinds.find((x: any) => x.kind === kind);
  const add = async () => {
    setAdding(true);
    try {
      const r = await callTool('models.add_provider', { kind, name: form.name || undefined, base_url: form.base_url || undefined, api_key: form.api_key || undefined, shared: form.shared });
      toast(`Connected: ${r.models} models`);
      setForm({ name: '', base_url: '', api_key: '', shared: false });
      list.reload();
    } catch (e) { err(e); } finally { setAdding(false); }
  };
  return (
    <div className="wos-split">
      <section>
        <h2 className="wos-h2">Your models</h2>
        <div className="ui-dtable-wrap">
          <table className="ui-dtable">
            <thead><tr><th>Provider</th><th className="hide-sm">Models</th><th>Who</th><th className="end" /></tr></thead>
            <tbody>
              {(list.data?.providers ?? []).map((p: any) => (
                <tr key={p.id}>
                  <td><div className="ui-who"><span><b>{p.name}</b><small>{p.kind === 'demo' ? 'A script, not AI. For trying wOS.' : p.base_url ?? 'api.anthropic.com'}</small></span></div></td>
                  <td className="hide-sm">{p.models.length || '-'}{list.data?.default.provider_id === p.id ? ' · default' : ''}</td>
                  <td>{p.kind === 'demo' ? 'Built in' : p.shared ? 'Team' : 'You'}</td>
                  <td className="end">
                    {p.kind !== 'demo' && p.id !== 'ollama-server' && (
                      <span className="wos-row wos-end">
                        <Btn tool="models.test_provider" size="sm" variant="ghost" onClick={async () => { const r = await callTool('models.test_provider', { provider_id: p.id }).catch(err); if (r) toast(r.ok ? `Answering: ${r.models} models` : r.error); list.reload(); }}>Test</Btn>
                        <Btn tool="models.remove_provider" size="sm" variant="ghost" onClick={async () => { await callTool('models.remove_provider', { provider_id: p.id }).catch(err); list.reload(); }}>Remove</Btn>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ui-hint">Keys are encrypted with a server key that is not kept in the database, and never shown again after you add them. Claude subscriptions cannot be used inside wOS (Anthropic's rule); connect wOS to the Claude app instead, from Settings, Account.</p>
      </section>
      <section className="ui-card">
        <h2 className="wos-h2">Add a model</h2>
        <form onSubmit={(e) => { e.preventDefault(); add(); }}>
          <label className="ui-field"><span>Provider</span>
            <select className="ui-select" value={kind} onChange={(e) => setKind(e.target.value)} data-tool="none" data-why="chooses which form to fill">
              {(list.data?.kinds ?? []).map((x: any) => <option key={x.kind} value={x.kind}>{x.label}</option>)}
            </select>
          </label>
          {(kind === 'ollama' || kind === 'openai_compatible') && <label className="ui-field"><span>Server address</span><input className="ui-input" value={form.base_url} placeholder={k?.default_url ?? 'http://localhost:1234/v1'} onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></label>}
          {kind !== 'ollama' && <label className="ui-field"><span>API key {kind === 'openai_compatible' && <small>if it needs one</small>}</span><input className="ui-input" type="password" autoComplete="off" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder={kind === 'anthropic' ? 'sk-ant-...' : kind === 'openai' ? 'sk-...' : ''} /></label>}
          <label className="ui-field"><span>Name <small>optional</small></span><input className="ui-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={k?.label} /></label>
          {admin(me.team!.scopes) && <label className="ui-check"><input type="checkbox" checked={form.shared} onChange={(e) => setForm({ ...form, shared: e.target.checked })} data-tool="none" data-why="part of the add form" /> Share with the whole team</label>}
          <Btn tool="models.add_provider" type="submit" className="is-block" disabled={adding}>{adding ? 'Connecting' : 'Test and add'}</Btn>
        </form>
      </section>
    </div>
  );
}

// ---------- team ----------

function Team() {
  const { me, reloadMe } = useShell();
  const t = useTool<any>('team.get');
  const [inv, setInv] = useState({ who: '', role: 'member' });
  const [link, setLink] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState('');
  const isAdmin = admin(me.team!.scopes);
  const invite = async () => {
    const who = inv.who.trim();
    try {
      const r = await callTool('team.invite', who.includes('@') && who.includes('.') && !who.startsWith('@') ? { email: who, role: inv.role } : { github: who.replace(/^@/, ''), role: inv.role });
      setLink(r.link);
      toast(r.emailed ? 'Invite emailed' : 'Invite made');
      setInv({ who: '', role: 'member' });
      t.reload();
    } catch (e) { err(e); }
  };
  return (
    <>
      <section className="wos-section">
        <div className="wos-row wos-between"><h2 className="wos-h2">{t.data?.team?.name ?? me.team!.name}</h2>{t.data?.team?.github_org && <span className="ui-chip is-outline">GitHub: {t.data.team.github_org}</span>}</div>
        <div className="ui-dtable-wrap">
          <table className="ui-dtable">
            <thead><tr><th>Person</th><th>Role</th><th className="hide-sm">Joined</th><th className="end" /></tr></thead>
            <tbody>
              {(t.data?.members ?? []).map((m: any) => (
                <tr key={m.id}>
                  <td><div className="ui-who"><Avatar name={m.name} url={m.avatar_url} /><span><b>{m.name}</b><small>{m.email ?? (m.github_login ? `@${m.github_login}` : '')}</small></span></div></td>
                  <td>
                    {isAdmin && m.role !== 'owner' ? (
                      <select className="ui-select wos-select-sm" value={m.role} data-tool="team.set_role" aria-label={`Role for ${m.name}`} onChange={async (e) => { await callTool('team.set_role', { user_id: m.id, role: e.target.value }).catch(err); t.reload(); }}>
                        <option value="admin">Admin</option><option value="member">Member</option><option value="guest">Guest (look only)</option>
                      </select>
                    ) : <span className="ui-chip">{m.role}</span>}
                  </td>
                  <td className="hide-sm">{ago(m.joined_at)}</td>
                  <td className="end">{isAdmin && m.role !== 'owner' && m.id !== me.user.id && <Btn tool="team.remove_member" size="sm" variant="ghost" onClick={async () => { await callTool('team.remove_member', { user_id: m.id }).catch(err); t.reload(); }}>Remove</Btn>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {isAdmin && (
        <section className="wos-section ui-card">
          <h2 className="wos-h2">Invite someone</h2>
          <form className="wos-row wos-wrap" onSubmit={(e) => { e.preventDefault(); invite(); }}>
            <input className="ui-input wos-grow" value={inv.who} onChange={(e) => setInv({ ...inv, who: e.target.value })} placeholder="Email address or GitHub username" aria-label="Email or GitHub username" />
            <select className="ui-select wos-select-sm" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })} data-tool="none" data-why="part of the invite form" aria-label="Role"><option value="member">Member</option><option value="admin">Admin</option><option value="guest">Guest</option></select>
            <Btn tool="team.invite" type="submit" disabled={inv.who.trim().length < 2}>Invite</Btn>
          </form>
          {link && <p className="ui-hint">Invite link (works for 14 days): <code className="wos-break">{link}</code></p>}
          {(t.data?.invites ?? []).length > 0 && (
            <ul className="wos-plain">{t.data.invites.map((i: any) => <li key={i.id} className="wos-row wos-between"><span>{i.email ?? `@${i.github_login}`} · {i.role}</span><Btn tool="team.revoke_invite" size="sm" variant="ghost" onClick={async () => { await callTool('team.revoke_invite', { invite_id: i.id }).catch(err); t.reload(); }}>Cancel</Btn></li>)}</ul>
          )}
          <GithubOrg current={t.data?.team?.github_org ?? ''} onDone={t.reload} />
        </section>
      )}
      <section className="wos-section">
        <h2 className="wos-h2">Your teams</h2>
        <ul className="wos-plain">
          {me.teams.map((x) => <li key={x.id} className="wos-row wos-between"><span>{x.name} <small className="wos-muted">· {x.role}</small></span>{x.id === me.team!.id ? <small className="wos-muted">current</small> : <Btn tool="account.switch_team" size="sm" variant="quiet" onClick={async () => { await callTool('account.switch_team', { team_id: x.id }).catch(err); location.href = '/'; }}>Switch</Btn>}</li>)}
        </ul>
        <form className="wos-row wos-wrap" onSubmit={async (e) => { e.preventDefault(); await callTool('team.create', { name: newTeam }).then(() => { location.href = '/'; }).catch(err); }}>
          <input className="ui-input wos-grow" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} placeholder="New team name" aria-label="New team name" />
          <Btn tool="team.create" type="submit" variant="quiet" disabled={newTeam.trim().length < 2}>Create team</Btn>
        </form>
      </section>
    </>
  );
}

function GithubOrg({ current, onDone }: { current: string; onDone: () => void }) {
  const [org, setOrg] = useState(current);
  useEffect(() => setOrg(current), [current]);
  return (
    <form className="wos-row wos-wrap wos-gap-top" onSubmit={async (e) => { e.preventDefault(); await callTool('team.update', { github_org: org.trim() }).then(() => toast('Saved')).catch(err); onDone(); }}>
      <input className="ui-input wos-grow" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="GitHub organization (its members join by signing in)" aria-label="GitHub organization" />
      <Btn tool="team.update" type="submit" variant="quiet">Link</Btn>
    </form>
  );
}

// ---------- alerts ----------

const KINDS = [['approval', 'Approvals'], ['question', 'Questions'], ['blocked', 'Blocked'], ['failed', 'Failed or out of budget'], ['done', 'Done']] as const;

function Alerts() {
  const r = useTool<any>('alerts.get_rules');
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const save = async (kind: string, patch: Record<string, unknown>) => {
    await callTool('alerts.set_rules', { kinds: { [kind]: patch } }).catch(err);
    r.reload();
  };
  const phone = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('This browser cannot receive push. On iPhone, add wOS to the home screen first.');
      if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications are blocked for this site in the browser settings.');
      setPerm('granted');
      const { public_key } = await callTool('alerts.push_key');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(public_key) });
      const j = sub.toJSON();
      await callTool('alerts.subscribe_push', { endpoint: j.endpoint, keys: j.keys, device: navigator.userAgent.slice(0, 80) });
      toast('Alerts will reach this device');
      r.reload();
    } catch (e) { err(e); }
  };
  const k = r.data?.kinds ?? {};
  return (
    <>
      <div className="wos-cards wos-cards-3">
        <div className="ui-card"><b>Browser</b><p>Pop up while wOS is open in a tab.</p>{perm === 'granted' ? <span className="ui-chip is-good">On</span> : <Btn tool="none" why="the browser's permission prompt is for the person only" variant="quiet" size="sm" onClick={async () => setPerm(await Notification.requestPermission())} disabled={perm === 'unsupported'}>Turn on</Btn>}</div>
        <div className="ui-card"><b>Phone and desktop push</b><p>Installed app or browser, even when wOS is closed. {r.data?.push_devices ? `${r.data.push_devices} device${r.data.push_devices > 1 ? 's' : ''}.` : ''}</p><div className="wos-row"><Btn tool="alerts.subscribe_push" variant="quiet" size="sm" onClick={phone}>Add this device</Btn>{r.data?.push_devices > 0 && <Btn tool="alerts.unsubscribe_push" variant="ghost" size="sm" onClick={async () => { await callTool('alerts.unsubscribe_push', {}).catch(err); r.reload(); }}>Remove all</Btn>}</div></div>
        <div className="ui-card"><b>Email</b><p>{r.data?.email ? `To ${r.data.email}.` : 'Add an email address to your account first.'} {r.data && !r.data.email_ready && 'Sending is not set up on this server yet.'}</p><Btn tool="alerts.send_test" variant="quiet" size="sm" onClick={async () => { await callTool('alerts.send_test', {}).catch(err); toast('Test alert sent'); }}>Send a test</Btn></div>
      </div>
      <div className="ui-dtable-wrap wos-section">
        <table className="ui-dtable">
          <thead><tr><th>When</th><th>Browser</th><th>Push</th><th>Email</th><th className="hide-sm">Email after</th></tr></thead>
          <tbody>
            {KINDS.map(([kind, label]) => (
              <tr key={kind}>
                <td>{label}</td>
                {(['desktop', 'push', 'email'] as const).map((ch) => <td key={ch}><label className="ui-check wos-check-cell"><input type="checkbox" checked={!!k[kind]?.[ch]} data-tool="alerts.set_rules" aria-label={`${label} by ${ch}`} onChange={(e) => save(kind, { [ch]: e.target.checked })} /></label></td>)}
                <td className="hide-sm"><select className="ui-select wos-select-sm" value={k[kind]?.email_after_min ?? 0} data-tool="alerts.set_rules" aria-label={`${label} email delay`} onChange={(e) => save(kind, { email_after_min: Number(e.target.value) })}>{[0, 5, 10, 30, 60].map((m) => <option key={m} value={m}>{m ? `${m} min unanswered` : 'At once'}</option>)}</select></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ui-hint">The inbox always gets everything. Email answers use signed links that ask you to confirm, so a forwarded email cannot approve anything by itself.</p>
    </>
  );
}

function urlB64(s: string) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ---------- account ----------

const SCHEMES = ['neutral', 'ops', 'midnight', 'tide', 'sage', 'ember', 'arcade', 'warroom'];

function Account() {
  const { me, reloadMe } = useShell();
  const [name, setName] = useState(me.user.name);
  const tokens = useTool<any>('account.list_tokens');
  const [tokName, setTokName] = useState('');
  const [made, setMade] = useState<string | null>(null);
  const [scheme, setScheme] = useState(document.documentElement.dataset.scheme ?? 'neutral');
  const [mode, setMode] = useState(document.documentElement.dataset.mode ?? 'auto');
  const mcp = `${location.origin}/mcp`;
  const look = (s: string, m: string) => {
    setScheme(s); setMode(m);
    document.documentElement.dataset.scheme = s;
    document.documentElement.dataset.mode = m;
    try { localStorage.setItem('wos-look', JSON.stringify({ scheme: s, mode: m })); } catch {}
  };
  return (
    <>
      <section className="wos-section ui-card">
        <h2 className="wos-h2">Profile</h2>
        <form className="wos-row wos-wrap" onSubmit={async (e) => { e.preventDefault(); await callTool('account.update_profile', { name }).then(() => { toast('Saved'); reloadMe(); }).catch(err); }}>
          <input className="ui-input wos-grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" />
          <Btn tool="account.update_profile" type="submit" variant="quiet">Save</Btn>
        </form>
        <p className="ui-hint">{me.user.email ?? ''}{me.user.github ? ` · GitHub @${me.user.github}` : ''}</p>
      </section>
      <section className="wos-section ui-card">
        <h2 className="wos-h2">Use wOS from Claude, ChatGPT, Codex or Claude Code</h2>
        <p>Add this address as a connector (MCP). You sign in once and choose what it may do. Your own subscription runs the model; wOS supplies the tools.</p>
        <code className="wos-code-line">{mcp}</code>
        <p className="ui-hint">Claude Code: <code>claude mcp add --transport http wos {mcp}</code> · Codex: <code>codex mcp add wos --url {mcp}</code></p>
      </section>
      <section className="wos-section">
        <h2 className="wos-h2">Connected apps and tokens</h2>
        <div className="ui-dtable-wrap">
          <table className="ui-dtable">
            <thead><tr><th>Name</th><th className="hide-sm">Can</th><th>Last used</th><th className="end" /></tr></thead>
            <tbody>
              {(tokens.data?.tokens ?? []).map((t: any) => <tr key={t.id}><td>{t.client_name ?? t.kind}</td><td className="hide-sm">{t.scopes.join(', ')}</td><td>{ago(t.used_at) || 'never'}</td><td className="end"><Btn tool="account.revoke_token" size="sm" variant="ghost" onClick={async () => { await callTool('account.revoke_token', { token_id: t.id }).catch(err); tokens.reload(); }}>Disconnect</Btn></td></tr>)}
              {!(tokens.data?.tokens ?? []).length && <tr><td colSpan={4} className="wos-muted">Nothing connected yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <form className="wos-row wos-wrap wos-gap-top" onSubmit={async (e) => { e.preventDefault(); const r = await callTool('account.create_token', { name: tokName }).catch(err); if (r?.token) { setMade(r.token); setTokName(''); tokens.reload(); } }}>
          <input className="ui-input wos-grow" value={tokName} onChange={(e) => setTokName(e.target.value)} placeholder="Token for a script, for example nightly import" aria-label="Token name" />
          <Btn tool="account.create_token" type="submit" variant="quiet" disabled={tokName.trim().length < 2}>Create token</Btn>
        </form>
        {made && <p className="ui-notice">Copy it now; it is not shown again: <code className="wos-break">{made}</code></p>}
      </section>
      <section className="wos-section ui-card">
        <h2 className="wos-h2">Look</h2>
        <div className="wos-row wos-wrap">
          <select className="ui-select wos-select-sm" value={scheme} onChange={(e) => look(e.target.value, mode)} data-tool="none" data-why="a display preference kept on this device" aria-label="Colour scheme">{SCHEMES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select>
          <div className="ui-seg">{['auto', 'light', 'dark'].map((m) => <button key={m} type="button" data-tool="none" data-why="a display preference kept on this device" aria-pressed={mode === m} onClick={() => look(scheme, m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}</div>
        </div>
      </section>
      <section className="wos-section">
        <Btn tool="account.sign_out" variant="quiet" onClick={async () => { await callTool('account.sign_out', {}).catch(() => {}); location.href = '/auth/sign-in'; }}>Sign out</Btn>
      </section>
    </>
  );
}

// ---------- hosting ----------

function Hosting() {
  const { me } = useShell();
  const st = useTool<any>('hosting.status');
  const [doc, setDoc] = useState<any>(null);
  const [exp, setExp] = useState<any>(null);
  const isAdmin = admin(me.team!.scopes);
  const log = useTool<any>(isAdmin ? 'audit.list' : null, { limit: 30 });
  return (
    <>
      <div className="wos-cards">
        <div className="ui-card wos-host">
          <b>Host it yourself, free</b>
          <p>One <code>docker compose up</code> runs wOS, Postgres and HTTPS on any server. Or one person runs it with nothing but Node and a SQLite file. Same code, no licence check, ever.</p>
          <a className="wos-link" href="https://github.com/warOnSaaS/suite#host-it-yourself" target="_blank" rel="noreferrer" data-tool="none" data-why="opens the self-host guide">Self-host guide</a>
        </div>
        <div className="ui-card wos-host">
          <b>Host with us</b>
          <p>We run it for you and charge what it costs us times two, plus $3 a person for support, shown openly. Move to your own hosting any time with one export.</p>
          <span className="ui-chip is-outline">Coming soon</span>
        </div>
      </div>
      {st.data && (
        <section className="wos-section ui-card">
          <h2 className="wos-h2">This server</h2>
          <dl className="ui-kv">
            <dt>Running as</dt><dd>{st.data.mode}</dd>
            <dt>Storage</dt><dd>{st.data.storage}</dd>
            <dt>Email</dt><dd>{st.data.email}</dd>
            <dt>Push</dt><dd>{st.data.push}</dd>
            <dt>Loaded apps</dt><dd>{st.data.loaded_apps.join(', ')}</dd>
            {st.data.reduced && <><dt>Note</dt><dd>{st.data.reduced}</dd></>}
          </dl>
        </section>
      )}
      {isAdmin && (
        <section className="wos-section wos-row wos-wrap">
          <Btn tool="hosting.doctor" variant="quiet" onClick={async () => setDoc(await callTool('hosting.doctor').catch(err))}>Check this server</Btn>
          <Btn tool="hosting.export" variant="quiet" onClick={async () => setExp(await callTool('hosting.export').catch(err))}>Export everything</Btn>
          {exp && <a className="wos-link" href={exp.url} data-tool="none" data-why="downloads the export file">Download export ({Math.round(exp.bytes / 1024)} KB)</a>}
        </section>
      )}
      {doc && <ul className="wos-plain wos-section">{doc.checks.map((c: any) => <li key={c.name} className="wos-check-row"><Dot status={c.ok ? 'done' : 'blocked'} /><span><b>{c.name}</b> {c.say}</span></li>)}</ul>}
      {isAdmin && (
        <section className="wos-section">
          <h2 className="wos-h2">Activity</h2>
          {(log.data?.entries ?? []).length ? (
            <div className="ui-dtable-wrap"><table className="ui-dtable"><thead><tr><th>Who</th><th>Did</th><th className="hide-sm">From</th><th>When</th></tr></thead><tbody>
              {log.data.entries.map((e: any) => <tr key={e.id}><td>{e.actor_name ?? e.actor_id}{e.actor_kind === 'agent' ? ' (agent)' : ''}</td><td><code>{e.tool}</code>{e.status !== 'ok' ? ` · ${e.status}` : ''}</td><td className="hide-sm">{e.via}</td><td>{ago(e.at)}</td></tr>)}
            </tbody></table></div>
          ) : <Empty icon="settings" title="No activity yet" />}
        </section>
      )}
    </>
  );
}
