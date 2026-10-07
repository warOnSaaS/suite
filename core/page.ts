// The few pages the server draws itself (sign-in, OAuth consent, answering an alert from email).
// Same kit as the shell: ui-design's CSS, served from /ui/.
import type { ServerResponse } from 'node:http';
import { esc } from './util.ts';

export function page(res: ServerResponse, status: number, title: string, inner: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', ...headers }).end(`<!doctype html><html lang="en" data-scheme="neutral" data-mode="auto" data-type="grotesk" data-shape="soft" data-density="comfortable" data-surface="bordered" data-motion="subtle">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)} · wOS</title><meta name="robots" content="noindex">
<link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/ui/src/ui.css"><link rel="stylesheet" href="/ui/src/tokens.css"><link rel="stylesheet" href="/wos-pages.css">
</head><body class="wos-gate"><main class="wos-gate-card">
<a class="wos-mark" href="/" aria-label="wOS home">wOS</a>
${inner}
</main></body></html>`);
}

export { esc };
