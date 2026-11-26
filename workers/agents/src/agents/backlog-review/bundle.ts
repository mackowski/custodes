import { parseAgentMd, Policy } from '@custodes/schema';
import type { BundledAgent } from '@custodes/llm';
import rawPolicy from '../../../../github-broker/policy/policy.json';
import orchestratorMd from './agent.md';
import itemReviewMd from './item-review/agent.md';
import backlogRules from './context/backlog-rules.md';
import operatorPreferences from './context/operator-preferences.md';

/** The bundled broker policy: the dispatcher routes with it, the broker still decides (ADR 0023). */
export const POLICY: Policy = Policy.parse(rawPolicy);

/** `context:` files by their path in agent.md. A listed file missing here fails at load. */
const CONTEXT: Readonly<Record<string, string>> = {
  'context/backlog-rules.md': backlogRules,
  'context/operator-preferences.md': operatorPreferences,
};

/**
 * One agent.md with its `context:` files appended to the prompt (trusted, bundled at build) and,
 * for roles that comment, the maintainers of `repo` from the policy: code-built, never model text.
 */
export function bundle(md: string, repo: string, policy: Policy = POLICY): BundledAgent {
  const { definition, prompt } = parseAgentMd(md);
  const parts = [prompt];
  for (const path of definition.context) {
    const text = Object.hasOwn(CONTEXT, path) ? CONTEXT[path] : undefined;
    if (text === undefined) throw new Error(`agent.md ${definition.id}: no bundled ${path}`);
    parts.push(text.trim());
  }
  const maintainers = policy.maintainers[repo] ?? [];
  if (definition.context.length > 0)
    parts.push(
      `# Maintainers of ${repo}\n\n${maintainers.length > 0 ? maintainers.map((m) => `- ${m}`).join('\n') : '- (none listed)'}`,
    );
  return { definition, prompt: parts.join('\n\n') };
}

/** The orchestrator and its roles for one repository. */
export function backlogAgents(repo: string): {
  root: BundledAgent;
  roles: Record<string, BundledAgent>;
} {
  return {
    root: bundle(orchestratorMd, repo),
    roles: { 'item-review': bundle(itemReviewMd, repo) },
  };
}
