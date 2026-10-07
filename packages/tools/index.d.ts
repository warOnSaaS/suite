export type Scope = 'read' | 'write' | 'delete' | 'admin';
export type Confirm = 'none' | 'human';

/** One entry in tools.json. */
export interface ToolSpec {
  /** app.verb_noun, for example chat.post_message */
  name: string;
  /** Sentence-case label, as a button would say it. */
  title: string;
  /** Plain words: what it does, when to use it, what comes back. */
  description: string;
  /** JSON Schema of the input (always type object). */
  input: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; [k: string]: unknown };
  /** JSON Schema of the result. */
  output: Record<string, unknown>;
  scope: Scope;
  confirm: Confirm;
  emits?: string[];
  test?: string;
  public?: boolean;
  hidden?: boolean;
}

/** A whole tools.json. */
export interface ToolCatalogue {
  $schema?: string;
  app: string;
  version?: 1;
  tools: ToolSpec[];
}

export const SCOPES: Scope[];
export const CONFIRMS: Confirm[];
export const NAME: RegExp;
export const APP_ID: RegExp;
export const EVENT: RegExp;
export function checkTool(t: unknown, app?: string): string[];
export function checkCatalogue(doc: unknown): string[];
export function toMcp(t: ToolSpec): Record<string, unknown>;
export function toOpenApi(tools: ToolSpec[], opts?: { title?: string; version?: string; server?: string }): Record<string, unknown>;
