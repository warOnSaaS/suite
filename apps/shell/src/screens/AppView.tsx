// Shows one app. Built-in screens are split out of the shell bundle and fetched only when opened;
// screens of apps from other repos come from /apps/<id>/screens.js, which the server refuses when the app is off;
// mounted apps (the CRM and the board today) show their own pages in a frame. An app that is off renders
// nothing here, so none of its code is ever requested.
import { useEffect, useRef, useState } from 'react';
import { callTool, on } from '../api.ts';
import { navigate, linkProps } from '../router.ts';
import { Empty, toast } from '../kit.tsx';
import { useShell, type AppInfo } from '../App.tsx';

const BUILTIN: Record<string, () => Promise<{ default: ScreenModule }>> = {
  agents: () => import('../../../../apps-builtin/agents/screens/index.tsx'),
};

export interface ScreenModule { title?: string; mount(el: HTMLElement, ctx: any): void | (() => void) | { unmount(): void; update?(path: string): void } }

export function AppView({ app, sub }: { app?: AppInfo; sub: string }) {
  if (!app || !app.on) {
    return <div className="ui-page"><Empty icon="settings" title="That app is off" action={<a className="ui-btn is-quiet" {...linkProps('/settings/apps')}>Open apps</a>}>Turn it on in Settings to use it here.</Empty></div>;
  }
  if (app.unavailable) return <div className="ui-page"><Empty icon="settings" title={`${app.name} is not available here`}>{app.unavailable}</Empty></div>;
  if (app.mount && !app.screens) return <Frame app={app} sub={sub} />;
  return <Screens app={app} sub={sub} />;
}

function Frame({ app, sub }: { app: AppInfo; sub: string }) {
  const src = `${app.mount!.path}${sub === '/' ? app.mount!.start ?? '/' : sub}`;
  return (
    <div className="wos-frame-wrap">
      <iframe className="wos-frame" src={src} title={app.name} data-app={app.id} />
    </div>
  );
}

function Screens({ app, sub }: { app: AppInfo; sub: string }) {
  const { me } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const handle = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const base = app.id === 'agents' ? '/agents' : `/a/${app.id}`;

  useEffect(() => {
    let dead = false;
    const load = BUILTIN[app.id] ?? (() => import(/* @vite-ignore */ app.screens!));
    load()
      .then((mod) => {
        if (dead || !ref.current) return;
        const ctx = { callTool, on, path: sub, navigate: (p: string) => navigate(`${base}${p === '/' ? '' : p}`), me: me.user, team: me.team, toast };
        handle.current = mod.default.mount(ref.current, ctx);
      })
      .catch((e) => setError(`Could not load ${app.name}: ${e.message}`));
    return () => {
      dead = true;
      const h = handle.current;
      if (typeof h === 'function') h();
      else h?.unmount?.();
      handle.current = null;
    };
  }, [app.id]);
  useEffect(() => { handle.current?.update?.(sub); }, [sub]);

  if (error) return <div className="ui-page"><Empty title="Could not open this app">{error}</Empty></div>;
  return <div ref={ref} className="wos-app-root" data-app={app.id} />;
}
