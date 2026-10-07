// Mounting an existing app as it is (the CRM and the board today, ROADMAP step 2): the suite runs the app's own
// Node request handler inside this server under /m/<id>/, rewrites its root-relative addresses to that prefix,
// and lets the shell show it in a frame. Its tools join the catalogue as <id>.<tool>, run through the app's own
// REST route in-process, so behaviour matches the standalone app exactly. Native screens replace the frame later.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ToolSpec } from './types.ts';
import { ROOT } from './core.ts';

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** First folder that holds the app: an env override, vendor/<name>, node_modules/<name>, or a sibling checkout. */
export function findApp(envDir: string | undefined, names: string[], marker: string) {
  const tries = [envDir, ...names.flatMap((n) => [path.join(ROOT, 'vendor', n), path.join(ROOT, 'node_modules', n), path.join(ROOT, '..', n)])].filter(Boolean) as string[];
  return tries.map((d) => path.resolve(d)).find((d) => fs.existsSync(path.join(d, marker))) ?? null;
}

export const importFrom = (dir: string, rel: string) => import(pathToFileURL(path.join(dir, rel)).href);

/** The app's tools as wOS tool specs, from its defineTools(session, register) and its own zod. */
export async function toolsFrom(dir: string, appId: string, defineToolsRel: string, session: any): Promise<ToolSpec[]> {
  const { defineTools } = await importFrom(dir, defineToolsRel);
  const req = createRequire(path.join(dir, 'package.json'));
  const { z } = await import(pathToFileURL(req.resolve('zod')).href);
  const { zodToJsonSchema } = await import(pathToFileURL(req.resolve('zod-to-json-schema')).href);
  const out: ToolSpec[] = [];
  defineTools(session, (name: string, meta: any) => {
    const schema: any = zodToJsonSchema(z.object(meta.shape ?? {}), { target: 'jsonSchema7', $refStrategy: 'none' });
    delete schema.$schema;
    const scope = meta.readOnly ? 'read' : meta.destructive ? 'delete' : 'write';
    let description = String(meta.description ?? meta.title ?? name).replace(/—/g, ',');
    if (description.length < 20) description = `${description} (${appId}).`.padEnd(20, '.');
    out.push({
      name: `${appId}.${name.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`,
      title: String(meta.title ?? name).slice(0, 60),
      description: description.slice(0, 1200),
      input: { type: 'object', ...schema },
      output: { type: 'object', properties: { result: { type: 'string' } } },
      scope,
      confirm: meta.destructive ? 'human' : 'none',
      test: 'test/unit/mount.test.ts',
    });
  });
  return out;
}

/** Run a request through a Node handler without a socket. Returns the status and body text. */
export async function inProcess(handler: NodeHandler, method: string, url: string, body: unknown, headers: Record<string, string> = {}) {
  const req = new PassThrough() as any;
  const text = body === undefined ? '' : JSON.stringify(body);
  Object.assign(req, { method, url, headers: { host: 'wos.internal', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers }, socket: { remoteAddress: '127.0.0.1', encrypted: false } });
  req.end(text);
  return new Promise<{ status: number; text: string; headers: Record<string, any> }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let status = 200;
    let hs: Record<string, any> = {};
    const res: any = {
      statusCode: 200,
      headersSent: false,
      setHeader(k: string, v: any) { hs[k.toLowerCase()] = v; },
      getHeader(k: string) { return hs[k.toLowerCase()]; },
      removeHeader(k: string) { delete hs[k.toLowerCase()]; },
      writeHead(s: number, ...rest: any[]) { status = s; const h = rest.find((x) => x && typeof x === 'object'); if (h) for (const [k, v] of Object.entries(h)) hs[k.toLowerCase()] = v; this.headersSent = true; return this; },
      write(c: any) { chunks.push(Buffer.from(c)); return true; },
      end(c?: any) { if (c) chunks.push(Buffer.from(c)); resolve({ status: status || this.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: hs }); return this; },
      on() { return this; }, once() { return this; }, emit() { return false; },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

// ---------- serving the app's pages under a prefix ----------

const ATTR = /\b(href|src|action|data-next|formaction|data-href)=(["'])\/(?![/])/g;
const JS_PATHS = /(\bfrom\s*|\bimport\s*\(\s*|\bfetch\(\s*|\bnew EventSource\(\s*|\blocation(?:\.href)?\s*=\s*)(["'`])\/(?![/])/g;

/** Rewrites the app's root-relative addresses to /m/<id>/..., in pages, scripts and redirects. */
export function rebaseText(text: string, base: string, kind: 'html' | 'js') {
  let out = text.replace(JS_PATHS, (_, a, q) => `${a}${q}${base}/`);
  if (kind === 'html') out = out.replace(ATTR, (_, a, q) => `${a}=${q}${base}/`);
  return out;
}

// Runs first in every mounted page: fetch, EventSource and history calls that still use a root-relative
// address (built at run time) go to the mount instead of the suite.
const prelude = (base: string) => `<script>(()=>{const B=${JSON.stringify(base)};const fix=u=>typeof u==='string'&&u.startsWith('/')&&!u.startsWith('//')&&!u.startsWith(B+'/')&&u!==B?B+u:u;const f=window.fetch;window.fetch=(u,o)=>f(u instanceof Request?u:fix(u),o);const E=window.EventSource;if(E)window.EventSource=function(u,o){return new E(fix(u),o)};for(const k of['pushState','replaceState']){const h=history[k].bind(history);history[k]=(s,t,u)=>h(s,t,fix(u))}document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[href]');if(a&&a.target==='_blank')return;},true);window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data&&e.data.wosNavigate)location.href=fix(e.data.wosNavigate)})})();</script>`;

/** Wrap a response so pages and scripts come out under base, and the page may sit in the suite's frame. */
export function mountResponse(res: ServerResponse, base: string) {
  let type = '';
  const fixLoc = (v: any) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith(`${base}/`) ? `${base}${v}` : v);
  const clean = (h: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(h)) {
      const lk = k.toLowerCase();
      if (lk === 'x-frame-options') continue;
      if (lk === 'content-type') type = String(v);
      if (lk === 'content-length') continue;
      if (lk === 'set-cookie') { out[k] = (Array.isArray(v) ? v : [v]).map((c: string) => c.replace(/Path=\/(;|$)/i, `Path=${base}/$1`)); continue; }
      out[k] = lk === 'location' ? fixLoc(v) : v;
    }
    return out;
  };
  const { writeHead, setHeader, end, write } = res as any;
  const buf: Buffer[] = [];
  let rewrite = false;
  (res as any).writeHead = function (status: number, ...rest: any[]) {
    const i = rest.findIndex((x) => x && typeof x === 'object');
    const h = clean(i >= 0 ? rest[i] : {});
    h['x-frame-options'] = 'SAMEORIGIN';
    rewrite = /text\/html|javascript/.test(type || String(res.getHeader('content-type') ?? ''));
    return writeHead.call(this, status, h);
  };
  (res as any).setHeader = function (k: string, v: any) {
    const lk = k.toLowerCase();
    if (lk === 'x-frame-options') return this;
    if (lk === 'content-type') type = String(v);
    if (lk === 'content-length') return this;
    return setHeader.call(this, k, lk === 'location' ? fixLoc(v) : v);
  };
  (res as any).write = function (c: any, ...rest: any[]) {
    if (rewrite || /text\/html|javascript/.test(type)) { buf.push(Buffer.from(c)); return true; }
    return write.call(this, c, ...rest);
  };
  (res as any).end = function (c?: any, ...rest: any[]) {
    const t = type || String(res.getHeader('content-type') ?? '');
    if (/text\/html|javascript/.test(t)) {
      if (c != null && typeof c !== 'function') buf.push(Buffer.from(c));
      let text = Buffer.concat(buf).toString('utf8');
      if (/text\/html/.test(t)) {
        text = rebaseText(text, base, 'html');
        text = text.includes('<head>') ? text.replace('<head>', `<head>${prelude(base)}`) : prelude(base) + text;
      } else text = rebaseText(text, base, 'js');
      return end.call(this, text);
    }
    return end.call(this, c, ...rest);
  };
  return res;
}

/** Serve a static file from the app's public folder (the CRM serves its own on Vercel, not from its handler). */
export function staticFrom(dir: string, sub: string, res: ServerResponse, base: string) {
  const f = path.join(dir, path.normalize(sub).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return false;
  const ext = path.extname(f);
  const type = ({ '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' } as Record<string, string>)[ext] ?? 'application/octet-stream';
  let body: Buffer | string = fs.readFileSync(f);
  if (ext === '.mjs' || ext === '.js') body = rebaseText(body.toString('utf8'), base, 'js');
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }).end(body);
  return true;
}
