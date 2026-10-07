// The no-side-doors lint (ROADMAP 3.2): screen code may only reach the server through /api/tools/*,
// /files/*, /media/* and the live event socket. Fails the build on any other fetch, XMLHttpRequest,
// EventSource, WebSocket or sendBeacon.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dirs = [path.join(root, 'apps/shell/src'), ...fs.readdirSync(path.join(root, 'apps-builtin')).map((d) => path.join(root, 'apps-builtin', d, 'screens'))];
const ALLOWED = [/^`?\/api\/tools\//, /^['"`]\/files\//, /^['"`]\/media\//, /^`\/api\/tools\/\$\{/];
// The one place that opens the live socket.
const LIVE = { file: path.join(root, 'apps/shell/src/api.ts'), pattern: /\/live/ };
const CALL = /\b(fetch|new\s+XMLHttpRequest|new\s+EventSource|new\s+WebSocket|navigator\.sendBeacon)\s*\(\s*([^,)]*)/g;

const problems = [];
const walk = (d) => {
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mjs|js)$/.test(f)) check(p);
  }
};
function check(file) {
  const text = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = CALL.exec(text))) {
    const [, kind, arg] = m;
    const target = arg.trim();
    const line = text.slice(0, m.index).split('\n').length;
    if (kind === 'fetch' && ALLOWED.some((re) => re.test(target.replace(/^['"]/, (q) => q)))) continue;
    if (kind === 'fetch' && /^`\/api\/tools\//.test(target)) continue;
    if (/WebSocket/.test(kind) && file === LIVE.file && LIVE.pattern.test(text.slice(m.index, m.index + 200))) continue;
    problems.push(`${path.relative(root, file)}:${line}: ${kind}(${target.slice(0, 60)}) goes around the tools. Call a tool with callTool() instead.`);
  }
}
for (const d of dirs) walk(d);
if (problems.length) { console.error(`no-side-doors: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log(`no-side-doors: screens only call /api/tools/* (and the live socket).`);
