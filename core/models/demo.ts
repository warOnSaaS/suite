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
  if (/deal|contact|lead|crm|client|clinic|pipeline/i.test(goal) && has(req, 'crm.find')) {
    const kind = /deal|pipeline/i.test(goal) ? 'deals' : /contact|lead/i.test(goal) ? 'contacts' : /clinic|client|organi[sz]ation/i.test(goal) ? 'organizations' : undefined;
    const name = goal.match(/\b[A-Z][a-z]{2,}(?:\s[A-Z][a-z]+)?/g)?.find((w) => !/^(Show|What|Research|Find|List|Draft|The|My|Any|Is|Who|How|Can)$/.test(w));
    return tool('crm.find', { ...(kind ? { kind } : {}), q: name ?? '', limit: 10 });
  }
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

// Plain commands the script understands, in the order they are written: "create a contact for Dana at
// Acme Dental and post in #general that I did". Each becomes a real tool call, one per turn.
function commandsIn(req: ChatRequest, text: string) {
  const out: { name: string; input: any; done: string }[] = [];
  const contact = /\b(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?contact\s+(?:for|called|named)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)(?:\s+(?:at|from|with)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*)*))?/.exec(text);
  if (contact && has(req, 'crm.create_contact')) {
    const [first, ...rest] = contact[1].trim().split(/\s+/);
    const org = contact[2]?.trim();
    out.push({ name: 'crm.create_contact', input: { first_name: first, ...(rest.length ? { last_name: rest.join(' ') } : {}), ...(org ? { org } : {}) }, done: `I created a contact for ${contact[1].trim()}${org ? ` at ${org}` : ''} in the CRM.` });
  }
  const post = /\b(?:post|say|write|send)\s+(?:a message\s+)?(?:in|to)\s+#([a-z0-9][\w-]*)\s*(?:that\s+|saying\s+|:\s*)?(.*)$/i.exec(text);
  if (post && has(req, 'chat.post_message')) {
    const said = post[2].trim().replace(/[.!]+$/, '');
    const body = !said || /^(i did|i have|i've done it|i did it|it is done|it's done|done)$/i.test(said) ? (out.map((c) => c.done).join(' ') || 'Done.') : said.charAt(0).toUpperCase() + said.slice(1) + '.';
    out.push({ name: 'chat.post_message', input: { channel: post[1], body }, done: `I posted in #${post[1]}: "${body}"` });
  }
  return out;
}

function chatTurn(req: ChatRequest): Part[] {
  const prev = lastResults(req.messages);
  const text0 = lastUserText(req.messages);
  const cmds = commandsIn(req, text0);
  if (cmds.length) {
    let lastUser = -1;
    req.messages.forEach((m, i) => { if (m.role === 'user' && m.content.some((p) => p.type === 'text')) lastUser = i; });
    const doneSoFar = req.messages.slice(lastUser + 1).filter((m) => m.role === 'assistant' && m.content.some((p) => p.type === 'tool_call')).length;
    const failed = prev.find((r: any) => r.isError || /^(error|that did not work)/i.test(r.output ?? ''));
    if (failed) return [say(`That did not work: ${failed.output.slice(0, 300)}`)];
    if (doneSoFar < cmds.length) { const c = cmds[doneSoFar]; return [say(doneSoFar ? 'Next,' : 'On it.'), tool(c.name, c.input)]; }
    return [say(`${cmds.map((c) => c.done).join(' ')}\n\n(Demo model: a script that calls real tools. Pick a real model in the model menu to have a proper conversation.)`)];
  }
  if (prev.length) {
    const out = prev.map((r) => `**${r.name}** returned:\n\n${r.output.length > 900 ? `${r.output.slice(0, 900)}...` : r.output}`).join('\n\n');
    return [say(`${out}\n\n(Demo model: a script that calls real tools. Pick a real model in the model menu to have a proper conversation.)`)];
  }
  const text = lastUserText(req.messages);
  const t = (/alert|inbox|approve|needs me/i.test(text) && has(req, 'alerts.list') ? tool('alerts.list', {}) : null) ?? readTool(req, text);
  if (t && /\w{3,}/.test(text) && !/^(hi|hello|hey)\b/i.test(text)) return [say('Let me look that up.'), t];
  return [say(`This is the demo model, a script rather than an AI, so it can only look things up. It can still show you how wOS works: try "show my CRM deals", "what is on the board", or "anything in my inbox?".\n\nTo talk to a real model, open the model menu and add an Anthropic or OpenAI key, a local Ollama, or any OpenAI-compatible server.`)];
}

export function demoAdapter(): Adapter {
  return {
    kind: 'demo',
    async listModels() { return [{ id: 'demo-scripted', name: 'Demo model (a script, not AI)', tools: true }]; },
    async chat(req) {
      return reply(req.system.includes('agents_set_plan') ? agentTurn(req) : chatTurn(req), req);
    },
  };
}
