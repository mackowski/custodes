/**
 * The `delegate` runtime tool (ADR 0023): an orchestrator hands one item to a child role and gets
 * back only structured fields, never the child's text. The child's proposal goes from the host
 * straight to the dispatcher with the child's own reads; the parent never relays it.
 */
import type { Proposal } from '@custodes/schema';
import { z } from 'zod';
import { defineTool, type RuntimeTool, type StopReason } from './runtime.js';

/** Children per orchestrator run (ADR 0023). */
export const MAX_CHILDREN_PER_RUN = 60;

/** How a child run ended. `stop` is an enum, so no error text reaches the parent's prompt. */
export type ChildOutcome =
  { ok: true; proposal: Proposal } | { ok: false; stop: StopReason | 'escalate' };

export interface DelegateOptions {
  /** The parent's `agents:`, from its bundled agent.md. */
  roles: readonly [string, ...string[]];
  /**
   * The repositories of the identity's read policy. A target names one of these, so a
   * model-chosen string never reaches the child's trusted task (security review of #140, L2).
   */
  repos: readonly [string, ...string[]];
  /**
   * Starts a child run of `role` on `target` with a task built by code (role + target, no text
   * from the parent), runs it with `childTools`, and hands its proposal to the dispatcher.
   */
  runChild(role: string, target: z.infer<ReturnType<typeof targetSchema>>): Promise<ChildOutcome>;
  maxPerRun?: number;
}

function targetSchema(repos: readonly [string, ...string[]]) {
  return z.strictObject({
    repo: z.enum(repos),
    kind: z.enum(['issue', 'pull']),
    number: z.number().int().positive(),
  });
}

/** Structured summary the parent sees: ids, counts and enums only (no bodies, no reason). */
function summary(role: string, target: unknown, out: ChildOutcome) {
  if (!out.ok) return { role, target, ok: false, stop: out.stop };
  return {
    role,
    target,
    ok: true,
    actions: out.proposal.actions.map((a) => a.type),
    evidence: out.proposal.evidence,
    needsHuman: out.proposal.needsHuman,
  };
}

/**
 * One tool per orchestrator run. It outlives the run's restarts (`runWithRestarts` reuses the
 * tools), so an item delegated before a restart returns its earlier summary instead of starting a
 * second child and a second proposal (lean review of #140).
 * shortcut: children run one at a time, because the loop runs tool calls in order; add a
 * concurrency limit if the loop ever runs them in parallel.
 */
export function delegateTool(opts: DelegateOptions): RuntimeTool {
  const max = opts.maxPerRun ?? MAX_CHILDREN_PER_RUN;
  const done = new Map<string, string>();
  return defineTool({
    name: 'delegate',
    description:
      'Hand one issue or pull request to a child role. You get back the actions it proposed (types only), its evidence and whether it needs a human. Delegating the same item again returns the same result.',
    args: z.strictObject({ role: z.enum(opts.roles), target: targetSchema(opts.repos) }),
    async run({ role, target }) {
      const key = `${role} ${target.repo} ${target.kind} ${String(target.number)}`;
      const earlier = done.get(key);
      if (earlier !== undefined) return { content: earlier };
      if (done.size >= max)
        return { content: JSON.stringify({ role, target, ok: false, stop: 'delegation_cap' }) };
      const content = JSON.stringify(summary(role, target, await opts.runChild(role, target)));
      done.set(key, content);
      return { content };
    },
  });
}

/** A child's tools: never `delegate` (depth 1, ADR 0023). The run store refuses depth 2 as well. */
export function childTools(tools: readonly RuntimeTool[]): RuntimeTool[] {
  return tools.filter((t) => t.name !== 'delegate');
}
