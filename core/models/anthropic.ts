// Claude through the Anthropic API with the person's or team's own key (never a claude.ai login, F5).
import Anthropic from '@anthropic-ai/sdk';
import type { Adapter, ChatRequest, ChatResponse, Part } from './types.ts';
import { toWire, fromWire } from './types.ts';

// Shown in the picker when the key cannot list models. The Models API is asked first.
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tools: true },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tools: true },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tools: true },
];

export function anthropicAdapter(apiKey: string, baseURL?: string): Adapter {
  const client = new Anthropic({ apiKey, baseURL: baseURL || undefined, maxRetries: 2 });
  return {
    kind: 'anthropic',
    async listModels() {
      try {
        const out: { id: string; name: string; tools: boolean }[] = [];
        for await (const m of client.models.list()) out.push({ id: m.id, name: m.display_name, tools: true });
        return out.length ? out : CLAUDE_MODELS;
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic did not accept that key.');
        return CLAUDE_MODELS;
      }
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((p): any => {
          if (p.type === 'text') return { type: 'text', text: p.text || ' ' };
          if (p.type === 'tool_call') return { type: 'tool_use', id: p.id, name: toWire(p.name), input: p.input ?? {} };
          if (p.type === 'tool_result') return { type: 'tool_result', tool_use_id: p.id, content: p.output, is_error: p.isError || undefined };
          if (p.type === 'opaque' && p.provider === 'anthropic') return p.block;
          return null;
        }).filter(Boolean),
      })).filter((m) => (m.content as unknown[]).length);
      const tools: Anthropic.Tool[] | undefined = req.tools?.length
        ? req.tools.map((t) => ({ name: toWire(t.name), description: t.description.slice(0, 1024), input_schema: t.input as Anthropic.Tool.InputSchema }))
        : undefined;
      try {
        const stream = client.messages.stream({ model: req.model, max_tokens: req.maxTokens ?? 16000, system: req.system, messages, tools }, { signal: req.signal });
        if (req.onText) stream.on('text', (d) => req.onText!(d));
        const msg = await stream.finalMessage();
        const parts: Part[] = [];
        for (const b of msg.content) {
          if (b.type === 'text') parts.push({ type: 'text', text: b.text });
          else if (b.type === 'tool_use') parts.push({ type: 'tool_call', id: b.id, name: fromWire(b.name), input: b.input });
          else parts.push({ type: 'opaque', provider: 'anthropic', block: b }); // thinking blocks go back unchanged
        }
        const stop = msg.stop_reason === 'tool_use' ? 'tool' : msg.stop_reason === 'max_tokens' ? 'max' : msg.stop_reason === 'refusal' ? 'refusal' : 'end';
        return { parts, stop, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens }, model: msg.model };
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic did not accept the API key. Check it in Settings, Models.');
        if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic says too many requests right now. Try again in a minute.');
        if (e instanceof Anthropic.NotFoundError) throw new Error(`Anthropic does not know the model ${req.model}.`);
        if (e instanceof Anthropic.BadRequestError) throw new Error(`Anthropic refused the request: ${e.message}`);
        if (e instanceof Anthropic.APIError) throw new Error(`Anthropic error ${e.status}: ${e.message}`);
        throw e;
      }
    },
  };
}
