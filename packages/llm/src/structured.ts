import type { z } from 'zod';

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

/**
 * Extracts the JSON object from model text and validates it. Candidates, in order: the first
 * ```-fenced block, then the first balanced object (string-aware, so ``` inside a string, e.g. code
 * in a suggestion, neither ends nor starts anything). The first that parses and validates wins: a
 * fenced answer whose strings hold ``` cuts the fence early, and then the object still parses.
 * Model output is untrusted: only what survives the schema reaches the rest of the system.
 */
export function parseStructured<T extends z.ZodType>(schema: T, text: string): z.infer<T> {
  const candidates = [fencedBlock(text), sliceFirstObject(text)].filter(
    (c): c is string => c !== null,
  );
  if (candidates.length === 0) throw new StructuredOutputError('no JSON object found', text);
  let error = 'invalid JSON';
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    error = `schema violation: ${result.error.message}`;
  }
  throw new StructuredOutputError(error, text);
}

/** Content of the first ``` fence (optionally ```json). indexOf, not a regex: linear on any input. */
function fencedBlock(text: string): string | null {
  const open = text.indexOf('```');
  if (open < 0) return null;
  let start = open + 3;
  if (text.slice(start, start + 4).toLowerCase() === 'json') start += 4;
  const close = text.indexOf('```', start);
  return close < 0 ? null : text.slice(start, close).trim();
}

function sliceFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
