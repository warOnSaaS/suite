// The model router: providers a team or a person adds (Anthropic key, OpenAI key, Ollama, any
// OpenAI-compatible server) plus the built-in demo model. Keys are sealed with the server key before they
// are stored and are never sent back to a screen.
import type { Core } from '../core.ts';
import type { CoreTool } from '../types.ts';
import type { Adapter } from './types.ts';
import { anthropicAdapter } from './anthropic.ts';
import { openaiAdapter } from './openai.ts';
import { demoAdapter } from './demo.ts';
import { seal, unseal } from '../crypto.ts';
import { id, now, parse, fail } from '../util.ts';

export * from './types.ts';

export type ProviderKind = 'anthropic' | 'openai' | 'ollama' | 'openai_compatible' | 'demo';
const KINDS: ProviderKind[] = ['anthropic', 'openai', 'ollama', 'openai_compatible'];
const LABEL: Record<ProviderKind, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', ollama: 'Ollama (local)', openai_compatible: 'OpenAI-compatible server', demo: 'Demo model' };
const DEFAULT_URL: Partial<Record<ProviderKind, string>> = { openai: 'https://api.openai.com/v1', ollama: 'http://localhost:11434/v1' };
const DEFAULT_MODEL: Partial<Record<ProviderKind, string>> = { anthropic: 'claude-opus-5-5', openai: 'gpt-5', demo: 'demo-scripted' };

export interface Provider { id: string; team_id: string; user_id: string | null; kind: ProviderKind; name: string; base_url: string | null; models: { id: string; name: string; tools: boolean }[]; default_model: string | null; shared: boolean; has_key: boolean }

const DEMO: Provider = { id: 'demo', team_id: '*', user_id: null, kind: 'demo', name: 'Demo model', base_url: null, models: [{ id: 'demo-scripted', name: 'Demo model (a script, not AI)', tools: true }], default_model: 'demo-scripted', shared: true, has_key: false };

export class Models {
  core: Core;
  constructor(core: Core) { this.core = core; }

  private view(r: any): Provider {
    return { id: r.id, team_id: r.team_id, user_id: r.user_id, kind: r.kind, name: r.name, base_url: r.base_url, models: parse(r.models, []), default_model: r.default_model, shared: !r.user_id, has_key: !!r.secret };
  }

  /** Providers a person can use on a team: the team's shared ones, their own, the server's Ollama, and the demo. */
  async visible(teamId: string, userId: string | null): Promise<Provider[]> {
    const rows = await this.core.db.query<any>('SELECT * FROM model_providers WHERE team_id = ? AND (user_id IS NULL OR user_id = ?) ORDER BY created_at', [teamId, userId ?? '-']);
    const out = rows.map((r) => this.view(r));
    if (this.core.env.OLLAMA_URL && !out.some((p) => p.kind === 'ollama')) out.push({ ...DEMO, id: 'ollama-server', kind: 'ollama', name: 'Ollama on this server', base_url: this.core.env.OLLAMA_URL, models: [], default_model: this.core.env.OLLAMA_MODEL ?? null });
    out.push(DEMO);
    return out;
  }

  async adapter(teamId: string, userId: string | null, providerId: string): Promise<{ adapter: Adapter; provider: Provider }> {
    if (providerId === 'demo') return { adapter: demoAdapter(), provider: DEMO };
    if (providerId === 'ollama-server' && this.core.env.OLLAMA_URL) {
      const p = (await this.visible(teamId, userId)).find((x) => x.id === 'ollama-server')!;
      return { adapter: openaiAdapter('ollama', this.core.env.OLLAMA_URL), provider: p };
    }
    const r = await this.core.db.get<any>('SELECT * FROM model_providers WHERE id = ? AND team_id = ? AND (user_id IS NULL OR user_id = ?)', [providerId, teamId, userId ?? '-']);
    if (!r) fail('no_provider', 'That model provider is not available to you. Pick another in the model menu.');
    const key = unseal<string>(r.secret, 'provider-key');
    const p = this.view(r);
    return { adapter: this.make(p.kind, p.base_url, key), provider: p };
  }

  make(kind: ProviderKind, baseUrl: string | null, key: string | null): Adapter {
    if (kind === 'anthropic') {
      if (!key) fail('no_key', 'This Anthropic provider has no API key.');
      return anthropicAdapter(key!, baseUrl ?? undefined);
    }
    if (kind === 'demo') return demoAdapter();
    const url = baseUrl || DEFAULT_URL[kind];
    if (!url) fail('no_url', 'This provider needs a server address.');
    return openaiAdapter(kind, url!, key);
  }

  /** The provider and model to use when none is chosen: the person's default, else the first real one, else the demo. */
  async pick(teamId: string, userId: string | null, providerId?: string | null, model?: string | null) {
    const list = await this.visible(teamId, userId);
    let p: Provider | undefined = providerId ? list.find((x) => x.id === providerId) : undefined;
    if (!p) {
      const pref = userId ? parse<any>((await this.core.db.get<any>('SELECT value FROM settings WHERE scope = ? AND key = ?', [`user:${userId}:${teamId}`, 'model']))?.value, null) : null;
      p = (pref && list.find((x) => x.id === pref.provider_id)) || list.find((x) => x.kind !== 'demo') || DEMO;
      if (!model && pref?.provider_id === p?.id) model = pref.model;
    }
    const provider: Provider = p ?? DEMO;
    return { provider, model: model || provider.default_model || provider.models[0]?.id || DEFAULT_MODEL[provider.kind] || '' };
  }
}

const S = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object' as const, properties: props, required, additionalProperties: false });

export function modelTools(core: Core): CoreTool[] {
  return [
    {
      spec: { name: 'models.list_providers', title: 'List models', description: 'The model providers you can use here (your own and the team shared ones), each with its models, plus your default. Keys are never shown.', input: S(), scope: 'read', confirm: 'none', test: 'test/unit/models.test.ts' },
      handler: async (_i, call: any) => {
        const providers = await core.models.visible(call.team.id, call.caller?.user?.id ?? null);
        const def = await core.models.pick(call.team.id, call.caller?.user?.id ?? null);
        return { providers, default: { provider_id: def.provider.id, model: def.model }, kinds: KINDS.map((k) => ({ kind: k, label: LABEL[k], needs_key: k === 'anthropic' || k === 'openai', default_url: DEFAULT_URL[k] ?? null })) };
      },
    },
    {
      spec: {
        name: 'models.add_provider', title: 'Add a model provider',
        description: 'Connect a model: an Anthropic or OpenAI API key, a local Ollama, or any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, OpenRouter). The connection is tested first. The key is encrypted at rest and never shown again. shared makes it usable by the whole team (admins only). Claude subscriptions cannot be used inside wOS; connect wOS to the Claude app instead.',
        input: S({ kind: { enum: KINDS }, name: { type: 'string', maxLength: 60 }, base_url: { type: 'string', description: 'Server address, for example http://localhost:11434/v1' }, api_key: { type: 'string', maxLength: 400 }, shared: { type: 'boolean', default: false }, default_model: { type: 'string' } }, ['kind']),
        scope: 'write', confirm: 'none', test: 'test/unit/models.test.ts',
      },
      handler: async ({ kind, name, base_url, api_key, shared, default_model }, call: any) => {
        if (shared && !call.scopes.includes('admin')) fail('scope', 'Only team admins can add a shared provider. Add it for yourself instead.', 403);
        if ((kind === 'anthropic' || kind === 'openai') && !api_key) fail('invalid_input', 'This provider needs an API key.');
        if (kind === 'openai_compatible' && !base_url) fail('invalid_input', 'Give the server address, for example http://localhost:1234/v1.');
        const adapter = core.models.make(kind, base_url ?? null, api_key ?? null);
        let models: { id: string; name: string; tools: boolean }[] = [];
        try { models = await adapter.listModels(); } catch (e: any) { fail('connect', `Could not connect: ${e.message}`); }
        const p = { id: id('mp'), name: name || LABEL[kind as ProviderKind], default_model: default_model || DEFAULT_MODEL[kind as ProviderKind] || models[0]?.id || null };
        await core.db.run('INSERT INTO model_providers (id, team_id, user_id, kind, name, base_url, secret, models, default_model, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          p.id, call.team.id, shared ? null : call.caller.user.id, kind, p.name, base_url || DEFAULT_URL[kind as ProviderKind] || null, api_key ? seal(api_key, 'provider-key') : null, JSON.stringify(models.slice(0, 200)), p.default_model, call.caller.user.id, now(),
        ]);
        return { id: p.id, kind, name: p.name, models: models.length, default_model: p.default_model, shared: !!shared };
      },
    },
    {
      spec: { name: 'models.remove_provider', title: 'Remove a model provider', description: 'Remove a provider and delete its stored key. Agents that used it switch to your default.', input: S({ provider_id: { type: 'string' } }, ['provider_id']), scope: 'delete', confirm: 'none', test: 'test/unit/models.test.ts' },
      handler: async ({ provider_id }, call: any) => {
        const r = await core.db.get<any>('SELECT user_id FROM model_providers WHERE id = ? AND team_id = ?', [provider_id, call.team.id]);
        if (!r) fail('not_found', 'No such provider.');
        if (!r.user_id && !call.scopes.includes('admin')) fail('scope', 'Only admins can remove a shared provider.', 403);
        if (r.user_id && r.user_id !== call.caller.user.id) fail('not_found', 'No such provider.');
        await core.db.run('DELETE FROM model_providers WHERE id = ?', [provider_id]);
        return { removed: true };
      },
    },
    {
      spec: { name: 'models.test_provider', title: 'Test a provider', description: 'Check that a provider still answers and refresh its list of models. Costs nothing: it only asks for the model list.', input: S({ provider_id: { type: 'string' } }, ['provider_id']), scope: 'read', confirm: 'none', test: 'test/unit/models.test.ts' },
      handler: async ({ provider_id }, call: any) => {
        const { adapter } = await core.models.adapter(call.team.id, call.caller.user.id, provider_id);
        try {
          const models = await adapter.listModels();
          if (provider_id !== 'demo' && provider_id !== 'ollama-server') await core.db.run('UPDATE model_providers SET models = ? WHERE id = ?', [JSON.stringify(models.slice(0, 200)), provider_id]);
          return { ok: true, models: models.length };
        } catch (e: any) {
          return { ok: false, error: e.message };
        }
      },
    },
    {
      spec: { name: 'models.set_default', title: 'Set default model', description: 'The provider and model new conversations and agents use unless you pick another.', input: S({ provider_id: { type: 'string' }, model: { type: 'string' } }, ['provider_id', 'model']), scope: 'write', confirm: 'none', test: 'test/unit/models.test.ts' },
      handler: async ({ provider_id, model }, call: any) => {
        const scope = `user:${call.caller.user.id}:${call.team.id}`;
        await core.db.run('DELETE FROM settings WHERE scope = ? AND key = ?', [scope, 'model']);
        await core.db.run('INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, ?)', [scope, 'model', JSON.stringify({ provider_id, model }), now()]);
        return { provider_id, model };
      },
    },
  ];
}
