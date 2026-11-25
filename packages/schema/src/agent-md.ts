import { z } from 'zod';
import type { Policy } from './policy.js';
import { AgentDefinition, BUDGET_CEILINGS } from './runtime.js';
import { highestTier } from './tiers.js';

/**
 * `agent.md` files (ADR 0023): frontmatter between `---` lines, then the system prompt. The
 * frontmatter is JSON, which is valid YAML, so the repository needs no YAML parser. Pure: the
 * runtime parses the bundled text and CI parses the files with the same function.
 */
export function parseAgentMd(text: string): { definition: AgentDefinition; prompt: string } {
  const normalised = text.replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) throw new Error('agent.md must start with --- frontmatter');
  const end = normalised.indexOf('\n---\n', 4);
  if (end === -1) throw new Error('agent.md frontmatter is not closed with ---');
  let raw: unknown;
  try {
    raw = JSON.parse(normalised.slice(4, end));
  } catch {
    throw new Error('agent.md frontmatter must be JSON');
  }
  const prompt = normalised.slice(end + 5).trim();
  if (prompt.length === 0) throw new Error('agent.md has no system prompt');
  return { definition: AgentDefinition.parse(raw), prompt };
}

/** Runtime tools that are not broker reads (ADR 0023). */
export const RUNTIME_TOOLS = ['delegate'] as const;

/**
 * Everything wrong with a set of agent definitions against the policy, as messages; empty means
 * fine. A role (an id another agent lists in `agents:`) runs under that agent's identity, so its
 * tools are checked against the parent's read policy and it has no policy entry of its own.
 */
export function checkAgentDefinitions(
  defs: readonly AgentDefinition[],
  policy: Policy,
  schemaExports: Readonly<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  if (byId.size !== defs.length) errors.push('two agent.md files share an id');
  const parentOf = new Map<string, string>();
  for (const d of defs)
    for (const role of d.agents) {
      if (!byId.has(role)) errors.push(`${d.id}: role ${role} has no agent.md`);
      else if (parentOf.has(role) && parentOf.get(role) !== d.id)
        errors.push(`${role}: listed by more than one agent`);
      else parentOf.set(role, d.id);
    }

  for (const d of defs) {
    const parent = parentOf.get(d.id);
    const identity = parent ?? d.id;
    if (parent !== undefined && d.agents.length > 0)
      errors.push(`${d.id}: a role cannot list agents (depth 1)`);
    if (parent !== undefined && (policy.agents[d.id] ?? policy.reads[d.id]))
      errors.push(`${d.id}: a role has no policy entry of its own`);

    const entry = policy.agents[identity];
    const expected = entry ? highestTier(entry.actions) : 'T0';
    if (d.tier !== expected) errors.push(`${d.id}: tier ${d.tier}, policy gives ${expected}`);

    const reads = policy.reads[identity]?.resources ?? [];
    const allowed = new Set<string>([...reads, ...(d.agents.length > 0 ? RUNTIME_TOOLS : [])]);
    for (const t of d.tools)
      if (!allowed.has(t)) errors.push(`${d.id}: tool ${t} is not in ${identity}'s read policy`);

    const schema = Object.hasOwn(schemaExports, d.outputSchema)
      ? schemaExports[d.outputSchema]
      : undefined;
    if (!(schema instanceof z.ZodType))
      errors.push(
        `${d.id}: outputSchema ${d.outputSchema} is not a zod schema of @custodes/schema`,
      );

    const b = d.budget;
    const rounds =
      d.agents.length > 0 ? BUDGET_CEILINGS.orchestratorRounds : BUDGET_CEILINGS.childRounds;
    if (b.roundsPerRun > rounds)
      errors.push(`${d.id}: roundsPerRun ${String(b.roundsPerRun)} > ${String(rounds)}`);
    if (parent !== undefined && b.usdPerRun > BUDGET_CEILINGS.childUsdPerRun)
      errors.push(
        `${d.id}: usdPerRun ${String(b.usdPerRun)} > ${String(BUDGET_CEILINGS.childUsdPerRun)}`,
      );
    if (b.usdPerDay > BUDGET_CEILINGS.usdPerDay)
      errors.push(
        `${d.id}: usdPerDay ${String(b.usdPerDay)} > ${String(BUDGET_CEILINGS.usdPerDay)}`,
      );
  }
  return errors;
}
