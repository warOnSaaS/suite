// @wos/manifest: check a wos-app.json, and the small helpers the suite uses to load one.
// No dependencies.

export const APP_ID = /^[a-z][a-z0-9-]{1,30}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const TOP = new Set(['$schema', 'id', 'name', 'description', 'version', 'license', 'requires', 'tools', 'tables', 'server', 'screens', 'icon', 'nav', 'events', 'needs', 'data', 'core', 'mount']);
const RESERVED = new Set(['api', 'mcp', 'auth', 'core', 'm', 'static', 'assets', 'files', 'media', 'live', 'account', 'team', 'apps', 'models', 'conversations', 'agents', 'alerts', 'audit', 'hosting', 'settings', 'billing', 'search']);

/** Problems with a manifest, as plain sentences. Empty means it is fine. */
export function checkManifest(m, { core = false } = {}) {
  if (!m || typeof m !== 'object') return ['wos-app.json must be an object.'];
  const out = [];
  for (const k of Object.keys(m)) if (!TOP.has(k)) out.push(`unknown field "${k}".`);
  if (typeof m.id !== 'string' || !APP_ID.test(m.id)) out.push('"id" must be lower case letters, digits or dashes, 2 to 31 long.');
  else if (!core && RESERVED.has(m.id)) out.push(`"id" "${m.id}" is reserved for the suite core.`);
  if (typeof m.name !== 'string' || m.name.length < 2) out.push('"name" is missing.');
  if (typeof m.description !== 'string' || m.description.length < 10) out.push('"description" must be one plain sentence.');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) out.push('"version" must be semantic, like 0.3.0.');
  if (!m.requires || typeof m.requires.core !== 'string') out.push('"requires.core" must say which core versions work, like ">=0.1".');
  if (typeof m.tools !== 'string') out.push('"tools" must point at tools.json.');
  for (const k of ['tables', 'server', 'screens']) if (m[k] !== undefined && typeof m[k] !== 'string') out.push(`"${k}" must be a path.`);
  if (m.core && !core) out.push('"core": true is only for apps inside the suite repo.');
  if (m.mount && !/^\/m\/[a-z][a-z0-9-]*$/.test(m.mount.path ?? '')) out.push('"mount.path" must look like /m/<id>.');
  if (/\u2014/.test(JSON.stringify(m))) out.push('contains an em dash; use plain punctuation.');
  return out;
}

/** Does `version` satisfy a simple range: ">=0.1", "^0.2.0", "0.x", "*". Enough for app requirements. */
export function satisfies(version, range) {
  if (!range || range === '*') return true;
  const v = parse(version);
  return String(range).split(/\s+/).every((part) => {
    const m = /^(>=|<=|>|<|\^|~|=)?\s*(.+)$/.exec(part);
    if (!m) return false;
    const [, op = '=', raw] = m;
    if (/x|\*/i.test(raw)) {
      const [a, b] = raw.split('.');
      return (a === 'x' || a === '*' || Number(a) === v[0]) && (b === undefined || b === 'x' || b === '*' || Number(b) === v[1]);
    }
    const r = parse(raw);
    const c = cmp(v, r);
    if (op === '>=') return c >= 0;
    if (op === '<=') return c <= 0;
    if (op === '>') return c > 0;
    if (op === '<') return c < 0;
    if (op === '^') return c >= 0 && (r[0] > 0 ? v[0] === r[0] : v[1] === r[1]);
    if (op === '~') return c >= 0 && v[0] === r[0] && v[1] === r[1];
    return c === 0;
  });
}
const parse = (s) => String(s).split('-')[0].split('.').map((n) => Number(n) || 0).concat([0, 0, 0]).slice(0, 3);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Migration files in apply order, picking the dialect-specific file when one exists.
 *  names: file names in the tables folder. dialect: 'postgres' | 'sqlite'. */
export function migrationOrder(names, dialect) {
  const by = new Map();
  for (const n of names) {
    const m = /^(\d{4})_([a-z0-9_]+?)(?:\.(postgres|sqlite))?\.sql$/.exec(n);
    if (!m) continue;
    const [, num, label, d] = m;
    if (d && d !== dialect) continue;
    const key = `${num}_${label}`;
    if (!by.has(key) || d) by.set(key, n);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, file]) => ({ id, file }));
}
