// A small router on the History API. Links carry data-tool="none" (they move around; they do not act).
import { useEffect, useState } from 'react';

const listeners = new Set<() => void>();
export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  listeners.forEach((l) => l());
}
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function usePath() {
  const [p, set] = useState(location.pathname + location.search);
  useEffect(() => {
    const l = () => set(location.pathname + location.search);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return p;
}

export function linkProps(to: string) {
  return {
    href: to,
    'data-tool': 'none',
    'data-why': 'navigation',
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
