// One shape for every model provider. Tool names use app.verb_noun inside wOS; providers only accept
// [A-Za-z0-9_-], so the adapters send app__verb_noun and map back.

export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: any }
  | { type: 'tool_result'; id: string; name?: string; output: string; isError?: boolean }
  /** Provider-specific blocks that must be sent back unchanged on the same provider (Claude thinking blocks). */
  | { type: 'opaque'; provider: string; block: any };

export interface Msg { role: 'user' | 'assistant'; content: Part[] }

export interface ModelTool { name: string; description: string; input: Record<string, unknown> }

export interface ChatRequest {
  model: string;
  system: string;
  messages: Msg[];
  tools?: ModelTool[];
  maxTokens?: number;
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface ChatResponse {
  parts: Part[];
  stop: 'end' | 'tool' | 'max' | 'refusal' | 'error';
  usage: { input: number; output: number };
  model: string;
}

export interface Adapter {
  kind: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<{ id: string; name: string; tools: boolean }[]>;
}

export const toWire = (name: string) => name.replace('.', '__');
export const fromWire = (name: string) => name.replace('__', '.');
export const textOf = (parts: Part[]) => parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
