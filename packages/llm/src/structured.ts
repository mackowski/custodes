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
 * Extracts the first JSON object from model text (fenced or bare) and validates it.
 * Model output is untrusted: only what survives the schema reaches the rest of the system.
 */
export function parseStructured<T extends z.ZodType>(schema: T, text: string): z.infer<T> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? sliceFirstObject(text);
  if (candidate === null) throw new StructuredOutputError('no JSON object found', text);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw new StructuredOutputError('invalid JSON', text);
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw new StructuredOutputError(`schema violation: ${result.error.message}`, text);
  return result.data;
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
