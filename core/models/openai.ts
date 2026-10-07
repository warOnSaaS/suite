// OpenAI, Ollama, LM Studio, llama.cpp, vLLM, OpenRouter and any other server that speaks the OpenAI
// chat completions format, with tool calling where the model supports it.
import type { Adapter, ChatRequest, ChatResponse, Part } from './types.ts';
import { toWire, fromWire } from './types.ts';

export function openaiAdapter(kind: string, baseUrl: string, apiKey?: string | null): Adapter {
  const base = baseUrl.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  return {
    kind,
    async listModels() {
      const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) }).catch((e) => { throw new Error(`Cannot reach ${base}: ${e.message}`); });
      if (r.status === 401 || r.status === 403) throw new Error(`${base} did not accept the key.`);
      if (!r.ok) throw new Error(`${base} answered ${r.status} when asked for its models.`);
      const j: any = await r.json();
      const list = (j.data ?? j.models ?? []).map((m: any) => ({ id: m.id ?? m.name, name: m.id ?? m.name, tools: true }));
      return kind === 'openai' ? list.filter((m: any) => /^(gpt|o\d|chatgpt)/.test(m.id)).sort((a: any, b: any) => b.id.localeCompare(a.id)) : list;
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const messages: any[] = [{ role: 'system', content: req.system }];
      for (const m of req.messages) {
        if (m.role === 'user') {
          const results = m.content.filter((p) => p.type === 'tool_result') as Extract<Part, { type: 'tool_result' }>[];
          for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
          const text = m.content.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n');
          if (text) messages.push({ role: 'user', content: text });
        } else {
          const text = m.content.filter((p) => p.type === 'text').map((p: any) => p.text).join('');
          const calls = m.content.filter((p) => p.type === 'tool_call') as Extract<Part, { type: 'tool_call' }>[];
          messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: toWire(c.name), arguments: JSON.stringify(c.input ?? {}) } })) } : {}) });
        }
      }
      const body: any = { model: req.model, messages, stream: true, stream_options: { include_usage: true } };
      if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: toWire(t.name), description: t.description.slice(0, 1024), parameters: t.input } }));
      if (kind === 'openai') body.max_completion_tokens = req.maxTokens ?? 16000;
      else body.max_tokens = req.maxTokens ?? 8000;
      const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal }).catch((e) => { throw new Error(`Cannot reach ${base}: ${e.message}`); });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        if (r.status === 401) throw new Error(`${base} did not accept the API key. Check it in Settings, Models.`);
        throw new Error(`${base} answered ${r.status}: ${t.slice(0, 300)}`);
      }
      let text = '';
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let finish = '';
      const usage = { input: 0, output: 0 };
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let j: any;
          try { j = JSON.parse(data); } catch { continue; }
          if (j.usage) { usage.input = j.usage.prompt_tokens ?? 0; usage.output = j.usage.completion_tokens ?? 0; }
          const ch = j.choices?.[0];
          if (!ch) continue;
          if (ch.finish_reason) finish = ch.finish_reason;
          const d = ch.delta ?? {};
          if (d.content) { text += d.content; req.onText?.(d.content); }
          for (const tc of d.tool_calls ?? []) {
            const cur = calls.get(tc.index ?? 0) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(tc.index ?? 0, cur);
          }
        }
      }
      const parts: Part[] = [];
      if (text) parts.push({ type: 'text', text });
      for (const [i, c] of calls) {
        let input: any = {};
        try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { _unparsed: c.args }; }
        parts.push({ type: 'tool_call', id: c.id || `call_${i}`, name: fromWire(c.name), input });
      }
      const stop = calls.size ? 'tool' : finish === 'length' ? 'max' : 'end';
      return { parts, stop, usage, model: req.model };
    },
  };
}
