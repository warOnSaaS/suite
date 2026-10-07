// @wos/tools: check a tools.json against the wOS catalogue format, and turn tools into MCP and OpenAPI shapes.
// No dependencies, so any app (plain JS or TypeScript) can copy or import it.

export const SCOPES = ['read', 'write', 'delete', 'admin'];
export const CONFIRMS = ['none', 'human'];
export const NAME = /^[a-z][a-z0-9-]{1,30}\.[a-z][a-z0-9_]{1,62}$/;
export const APP_ID = /^[a-z][a-z0-9-]{1,30}$/;
export const EVENT = /^[a-z][a-z0-9-]*\.[a-z0-9_.]+$/;
const KEYS = new Set(['name', 'title', 'description', 'input', 'output', 'scope', 'confirm', 'emits', 'test', 'public', 'hidden']);

/** Problems with one tool, as plain sentences. Empty means it is fine. */
export function checkTool(t, app) {
  const out = [];
  const where = t && typeof t.name === 'string' ? t.name : '(a tool with no name)';
  if (!t || typeof t !== 'object') return ['A tool must be an object.'];
  for (const k of Object.keys(t)) if (!KEYS.has(k)) out.push(`${where}: unknown field "${k}".`);
  if (typeof t.name !== 'string' || !NAME.test(t.name)) out.push(`${where}: name must look like app.verb_noun.`);
  else if (app && !t.name.startsWith(`${app}.`)) out.push(`${where}: name must start with "${app}.".`);
  if (typeof t.title !== 'string' || t.title.length < 2 || t.title.length > 60) out.push(`${where}: title must be 2 to 60 characters.`);
  if (typeof t.description !== 'string' || t.description.length < 20) out.push(`${where}: description must say in plain words what it does (20 characters or more).`);
  if (!t.input || t.input.type !== 'object') out.push(`${where}: input must be a JSON Schema with "type": "object".`);
  if (!t.output || typeof t.output !== 'object') out.push(`${where}: output schema is missing.`);
  if (!SCOPES.includes(t.scope)) out.push(`${where}: scope must be one of ${SCOPES.join(', ')}.`);
  if (!CONFIRMS.includes(t.confirm)) out.push(`${where}: confirm must be none or human.`);
  if (t.emits !== undefined && (!Array.isArray(t.emits) || t.emits.some((e) => typeof e !== 'string' || !EVENT.test(e)))) out.push(`${where}: emits must be a list of event names like chat.message.posted.`);
  if (t.test !== undefined && typeof t.test !== 'string') out.push(`${where}: test must be a path.`);
  if (/\u2014/.test(JSON.stringify(t))) out.push(`${where}: contains an em dash; use plain punctuation.`);
  return out;
}

/** Problems with a whole tools.json. */
export function checkCatalogue(doc) {
  if (!doc || typeof doc !== 'object') return ['tools.json must be an object with "app" and "tools".'];
  const out = [];
  if (typeof doc.app !== 'string' || !APP_ID.test(doc.app)) out.push('"app" must be the app id, lower case.');
  if (!Array.isArray(doc.tools)) return [...out, '"tools" must be a list.'];
  const seen = new Set();
  for (const t of doc.tools) {
    out.push(...checkTool(t, doc.app));
    if (t?.name && seen.has(t.name)) out.push(`${t.name}: listed twice.`);
    seen.add(t?.name);
  }
  return out;
}

/** The MCP tools/list entry for a tool. */
export function toMcp(t) {
  return {
    name: t.name,
    title: t.title,
    description: t.confirm === 'human' ? `${t.description} A person must approve this before it runs.` : t.description,
    inputSchema: t.input,
    outputSchema: t.output?.type === 'object' ? t.output : undefined,
    annotations: { title: t.title, readOnlyHint: t.scope === 'read', destructiveHint: t.scope === 'delete', idempotentHint: t.scope === 'read', openWorldHint: false },
  };
}

/** An OpenAPI 3.1 document for a list of tools, served at POST /api/tools/<name>. */
export function toOpenApi(tools, { title = 'wOS', version = '0.1.0', server } = {}) {
  const paths = {};
  for (const t of tools) {
    paths[`/api/tools/${t.name}`] = {
      post: {
        operationId: t.name.replace('.', '__'),
        summary: t.title,
        description: t.description.slice(0, 300),
        'x-openai-isConsequential': t.scope !== 'read' || t.confirm === 'human',
        'x-wos-scope': t.scope,
        'x-wos-confirm': t.confirm,
        requestBody: { required: true, content: { 'application/json': { schema: t.input } } },
        responses: {
          200: { description: 'Done', content: { 'application/json': { schema: { type: 'object', properties: { result: t.output } } } } },
          202: { description: 'Waiting for a person to approve', content: { 'application/json': { schema: { type: 'object', properties: { pending: { type: 'object' } } } } } },
        },
      },
    };
  }
  return { openapi: '3.1.0', info: { title, version }, servers: server ? [{ url: server }] : [], paths };
}
