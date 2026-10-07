// The demo model: a script, not AI. It lets anyone try conversations, the agents grid, plans, the inbox and
// alerts with no API key, and lets tests run without spending money. It calls real tools.
import type { Adapter, ChatRequest, ChatResponse, Part, Msg } from './types.ts';

let seq = 0;
const callId = () => `demo_${Date.now().toString(36)}_${seq++}`;
const has = (req: ChatRequest, name: string) => !!req.tools?.some((t) => t.name === name);
const lastUserText = (msgs: Msg[]) => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = msgs[i].content.find((p) => p.type === 'text') as any;
    if (msgs[i].role === 'user' && t) return t.text as string;
  }
  return '';
};
const lastResults = (msgs: Msg[]) => (msgs.at(-1)?.content.filter((p) => p.type === 'tool_result') ?? []) as Extract<Part, { type: 'tool_result' }>[];

function reply(parts: Part[], req: ChatRequest): ChatResponse {
  for (const p of parts) if (p.type === 'text' && req.onText) for (const w of p.text.split(/(?<=\s)/)) req.onText(w);
  return { parts, stop: parts.some((p) => p.type === 'tool_call') ? 'tool' : 'end', usage: { input: 0, output: 0 }, model: 'demo-scripted' };
}
const tool = (name: string, input: any): Part => ({ type: 'tool_call', id: callId(), name, input });
const say = (text: string): Part => ({ type: 'text', text });

function readTool(req: ChatRequest, goal: string) {
  if (/deal|contact|lead|crm|client|clinic|pipeline/i.test(goal) && has(req, 'crm.find')) return tool('crm.find', { q: goal.split(/\s+/).find((w) => w.length > 4 && /^[a-z]/i.test(w)) ?? '' });
  if (/task|board|week|plan/i.test(goal) && has(req, 'board.my_day')) return tool('board.my_day', {});
  if (has(req, 'apps.list')) return tool('apps.list', {});
  return null;
}

function agentTurn(req: ChatRequest): Part[] {
  const turn = req.messages.filter((m) => m.role === 'assistant').length;
  const goal = lastUserTextFirst(req.messages);
  const prev = lastResults(req.messages);
  const steps = planFor(goal);
  const evidence = (r?: Extract<Part, { type: 'tool_result' }>) => (r ? `${r.name ?? 'tool'}: ${r.output.replace(/\s+/g, ' ').slice(0, 120)}` : 'checked');
  switch (turn) {
    case 0: return [say(`Plan for: ${goal}`), tool('agents.set_plan', { steps })];
    case 1: { const t = readTool(req, goal); return t ? [say('Reading what we already have.'), t] : [tool('agents.complete_step', { n: 1, evidence: 'read the brief' })]; }
    case 2: return [tool('agents.complete_step', { n: 1, evidence: evidence(prev[0]) })];
    case 3: return [say('Checking the inbox and open questions.'), has(req, 'alerts.list') ? tool('alerts.list', {}) : tool('agents.complete_step', { n: 2, evidence: 'nothing open' })];
    case 4: return [tool('agents.complete_step', { n: 2, evidence: evidence(prev[0]) })];
    case 5: return [tool('agents.ask', { question: `Before I write this up: go ahead with "${goal.slice(0, 80)}"?`, options: ['Go ahead', 'Keep it short', 'Stop here'] })];
    case 6: {
      const answer = prev[0]?.output ?? '';
      if (/stop here/i.test(answer)) return [say('Stopping here, as you asked. Nothing else was changed.')];
      return [tool('agents.complete_step', { n: 3, evidence: `person answered: ${answer.slice(0, 80)}` })];
    }
    case 7: return [tool('agents.complete_step', { n: 4, evidence: 'summary written below' })];
    default: return [say(`Done. ${steps.length} of ${steps.length} steps complete for "${goal.slice(0, 80)}". This was the demo model: add an Anthropic or OpenAI key, or Ollama, in Settings to run a real one.`)];
  }
}

function lastUserTextFirst(msgs: Msg[]) {
  const first = msgs.find((m) => m.role === 'user')?.content.find((p) => p.type === 'text') as any;
  return String(first?.text ?? 'the task').replace(/^Goal:\s*/i, '').split('\n')[0].trim();
}

function planFor(goal: string) {
  if (/research|find|list/i.test(goal)) return ['Read the brief and what we know', 'Look through the records we have', 'Confirm the approach with you', 'Write up what I found'];
  if (/email|follow|reply|draft/i.test(goal)) return ['Read the thread and the contact', 'Check open tasks and alerts', 'Confirm the tone with you', 'Draft the message'];
  return ['Read the brief', 'Gather what we already have', 'Check the approach with you', 'Write up the result'];
}

function chatTurn(req: ChatRequest): Part[] {
  const prev = lastResults(req.messages);
  if (prev.length) {
    const out = prev.map((r) => `**${r.name}** returned:\n\n${r.output.length > 900 ? `${r.output.slice(0, 900)}...` : r.output}`).join('\n\n');
    return [say(`${out}\n\n(Demo model: a script that calls real tools. Pick a real model in the model menu to have a proper conversation.)`)];
  }
  const text = lastUserText(req.messages);
  const t = readTool(req, text) ?? (/alert|inbox|approve/i.test(text) && has(req, 'alerts.list') ? tool('alerts.list', {}) : null);
  if (t && /\w{3,}/.test(text) && !/^(hi|hello|hey)\b/i.test(text)) return [say('Let me look that up.'), t];
  return [say(`This is the demo model, a script rather than an AI, so it can only look things up. It can still show you how wOS works: try "show my CRM deals", "what is on the board", or "anything in my inbox?".\n\nTo talk to a real model, open the model menu and add an Anthropic or OpenAI key, a local Ollama, or any OpenAI-compatible server.`)];
}

export function demoAdapter(): Adapter {
  return {
    kind: 'demo',
    async listModels() { return [{ id: 'demo-scripted', name: 'Demo model (a script, not AI)', tools: true }]; },
    async chat(req) {
      return reply(req.system.includes('agents__set_plan') ? agentTurn(req) : chatTurn(req), req);
    },
  };
}
