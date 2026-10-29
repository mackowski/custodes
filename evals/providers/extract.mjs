// The JSON the agent would parse, as parseStructured (packages/llm/src/structured.ts) finds it:
// the first ```-fenced block, then the outermost object; the first that parses wins. A fenced
// answer whose strings hold ``` (code in a suggestion) cuts the fence early; the object still parses.

/** @param {string} t */
export function extractJson(t) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)?.[1];
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  const object = i >= 0 && j > i ? t.slice(i, j + 1) : undefined;
  for (const c of [fenced, object]) {
    if (c === undefined) continue;
    try {
      JSON.parse(c);
      return c;
    } catch {
      /* next candidate */
    }
  }
  return fenced ?? object ?? t;
}
