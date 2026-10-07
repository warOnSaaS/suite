// Checks a tool input against its JSON Schema before the handler runs. Covers the subset tools use:
// type, properties, required, additionalProperties, enum, const, items, minItems, maxItems, minLength, maxLength,
// minimum, maximum, pattern, anyOf, oneOf. Unknown keywords are ignored. Fills in `default` values.

type Schema = Record<string, any>;

export function validate(schema: Schema | undefined, value: unknown, at = 'input'): { ok: true; value: any } | { ok: false; error: string } {
  if (!schema) return { ok: true, value };
  const errors: string[] = [];
  const out = check(schema, value, at, errors);
  return errors.length ? { ok: false, error: errors.slice(0, 5).join('; ') } : { ok: true, value: out };
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const matches = (t: string, v: unknown) => {
  const got = typeOf(v);
  return t === got || (t === 'number' && got === 'integer');
};

function check(s: Schema, v: any, at: string, errs: string[]): any {
  if (s.anyOf || s.oneOf) {
    for (const alt of s.anyOf ?? s.oneOf) {
      const e: string[] = [];
      const out = check(alt, v, at, e);
      if (!e.length) return out;
    }
    errs.push(`${at}: does not match any allowed shape`);
    return v;
  }
  if (s.const !== undefined && v !== s.const) errs.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: must be one of ${s.enum.join(', ')}`);
  if (s.type) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matches(t, v))) {
      // Forms send numbers and flags as strings; accept the obvious ones.
      if (types.includes('integer') || types.includes('number')) {
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) v = Number(v);
      }
      if (types.includes('boolean') && (v === 'true' || v === 'false')) v = v === 'true';
      if (!types.some((t) => matches(t, v))) { errs.push(`${at}: should be ${types.join(' or ')}`); return v; }
    }
  }
  if (typeof v === 'string') {
    if (s.minLength != null && v.length < s.minLength) errs.push(`${at}: too short`);
    if (s.maxLength != null && v.length > s.maxLength) errs.push(`${at}: too long (at most ${s.maxLength})`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push(`${at}: is not in the right form`);
  }
  if (typeof v === 'number') {
    if (s.minimum != null && v < s.minimum) errs.push(`${at}: at least ${s.minimum}`);
    if (s.maximum != null && v > s.maximum) errs.push(`${at}: at most ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) errs.push(`${at}: needs at least ${s.minItems}`);
    if (s.maxItems != null && v.length > s.maxItems) errs.push(`${at}: at most ${s.maxItems}`);
    if (s.items) v = v.map((x, i) => check(s.items, x, `${at}[${i}]`, errs));
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && (s.properties || s.required || s.additionalProperties === false)) {
    const props = s.properties ?? {};
    const o: Record<string, any> = { ...v };
    for (const r of s.required ?? []) if (o[r] === undefined || o[r] === null || o[r] === '') errs.push(`${at === 'input' ? r : `${at}.${r}`}: required`);
    for (const [k, ps] of Object.entries<any>(props)) {
      if (o[k] === undefined && ps.default !== undefined) o[k] = structuredClone(ps.default);
      if (o[k] !== undefined && !(o[k] === '' && !(s.required ?? []).includes(k))) o[k] = check(ps, o[k], at === 'input' ? k : `${at}.${k}`, errs);
      else if (o[k] === '') delete o[k];
    }
    if (s.additionalProperties === false) for (const k of Object.keys(o)) if (!(k in props)) errs.push(`${at === 'input' ? k : `${at}.${k}`}: not expected`);
    return o;
  }
  return v;
}
