/**
 * The `delegate` runtime tool (ADR 0023): an orchestrator hands one item to a child role and gets
 * back only structured fields, never the child's text. The child's proposal goes from the host
 * straight to the dispatcher with the child's own reads; the parent never relays it.
 */
import { ProposalTarget, type Proposal } from '@custodes/schema';
import { z } from 'zod';
import { defineTool, type RuntimeTool } from './runtime.js';

/** Children per orchestrator run, and at once (ADR 0023). */
export const MAX_CHILDREN_PER_RUN = 60;
export const MAX_CONCURRENT_CHILDREN = 3;

export type ChildOutcome = { ok: true; proposal: Proposal } | { ok: false; stop: string };

export interface DelegateOptions {
  /** The parent's `agents:`, from its bundled agent.md. */
  roles: readonly [string, ...string[]];
  /**
   * Starts a child run of `role` on `target` with a task built by code (role + target, no text
   * from the parent), runs it with `childTools`, and hands its proposal to the dispatcher.
   */
  runChild(role: string, target: ProposalTarget): Promise<ChildOutcome>;
  maxPerRun?: number;
  maxConcurrent?: number;
}

/** Structured summary the parent sees: ids, counts and enums only (no bodies, no reason). */
function summary(role: string, target: ProposalTarget, out: ChildOutcome) {
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

export function delegateTool(opts: DelegateOptions): RuntimeTool {
  const max = opts.maxPerRun ?? MAX_CHILDREN_PER_RUN;
  const limit = opts.maxConcurrent ?? MAX_CONCURRENT_CHILDREN;
  let started = 0;
  let running = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    while (running >= limit) await new Promise<void>((r) => waiting.push(r));
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  return defineTool({
    name: 'delegate',
    description:
      'Hand one issue or pull request to a child role. You get back the actions it proposed (types only), its evidence and whether it needs a human.',
    args: z.strictObject({ role: z.enum(opts.roles), target: ProposalTarget }),
    async run({ role, target }) {
      if (started >= max)
        return { content: JSON.stringify({ role, target, ok: false, stop: 'delegation_cap' }) };
      started++;
      await acquire();
      try {
        return {
          content: JSON.stringify(summary(role, target, await opts.runChild(role, target))),
        };
      } finally {
        release();
      }
    },
  });
}

/** A child's tools: never `delegate` (depth 1, ADR 0023). The run store refuses depth 2 as well. */
export function childTools(tools: readonly RuntimeTool[]): RuntimeTool[] {
  return tools.filter((t) => t.name !== 'delegate');
}
