import { z } from 'zod';
import { BrokerAction } from './actions.js';
import type { IssueSnapshot, PullSnapshot } from './admin.js';
import { AgentId, GitHubRepo } from './agent.js';
import { Tier } from './tiers.js';

/**
 * Ceilings no agent.md may exceed (ADR 0023). An orchestrator is an agent with `agents:`; its
 * per-run spend is bounded by the tree's daily budget. One definition: the zod maxima below and the
 * CI check (`checkAgentDefinitions`) both use it.
 */
export const BUDGET_CEILINGS = {
  orchestratorRounds: 40,
  childRounds: 20,
  childUsdPerRun: 0.15,
  usdPerDay: 3,
} as const;

/**
 * The frontmatter of an `agent.md` (ADR 0023). The body is the system prompt. Bundled at build
 * time; nothing here widens policy, the broker decides.
 */
export const AgentDefinition = z.strictObject({
  id: AgentId,
  /** Checked in CI against the tier derived from policy (ADR 0022). */
  tier: Tier,
  triggers: z.array(z.enum(['schedule', 'webhook', 'manual', 'delegate'])).min(1),
  model: z.string().min(1).max(100),
  /** Tool names: reads from the agent's read policy plus runtime tools. */
  tools: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/))
    .min(1)
    .max(30),
  /** Roles this agent may delegate to (depth 1). */
  agents: z.array(AgentId).max(10).default([]),
  /** SOP files bundled with the agent, relative to its directory. */
  context: z
    .array(z.string().regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.md$/))
    .max(20)
    .default([]),
  /** Name of a zod schema exported by `packages/schema`. */
  outputSchema: z.string().regex(/^[A-Z][A-Za-z0-9]{1,60}$/),
  budget: z.strictObject({
    roundsPerRun: z.number().int().min(1).max(BUDGET_CEILINGS.orchestratorRounds),
    usdPerRun: z.number().positive().max(BUDGET_CEILINGS.usdPerDay),
    usdPerDay: z.number().positive().max(BUDGET_CEILINGS.usdPerDay),
  }),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/** The issue or pull request a proposal is about. */
export const ProposalTarget = z.strictObject({
  repo: GitHubRepo,
  kind: z.enum(['issue', 'pull']),
  number: z.number().int().positive(),
});
export type ProposalTarget = z.infer<typeof ProposalTarget>;

/**
 * A machine-checkable reason for an action: numbers, ids and times, never prose. `ref` is a short
 * constrained string (a number, a thread id or a check name), not a channel for text: it reaches
 * a parent run through `delegate` (security review of #140, L3).
 */
export const Evidence = z.strictObject({
  type: z.enum(['merged_pr', 'unresolved_thread', 'ci_fail', 'last_activity', 'review']),
  /** A PR or issue number (`#12`), a thread id or a check name. */
  ref: z.string().regex(/^#?[A-Za-z0-9._-]{1,40}$/),
  at: z.iso.datetime({ offset: true }).optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * What one run proposes for one target (ADR 0023). Routed by the dispatcher, never run as-is. It
 * carries no snapshot: the dispatcher attaches the one code built from this run's read.
 */
export const Proposal = z.strictObject({
  target: ProposalTarget,
  actions: z.array(BrokerAction).max(7),
  evidence: z.array(Evidence).max(20),
  /** Shown to the operator as untrusted model text. */
  reason: z.string().max(2000),
  /** The model may raise every action to an approval, never lower one. */
  needsHuman: z.boolean(),
});
export type Proposal = z.infer<typeof Proposal>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** One tool call as code recorded it. Hashes only: no argument or result text. */
export const ToolCallRecord = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  argsHash: Sha256,
  resultHash: Sha256,
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

/**
 * Carried into a fresh run after a cap (ADR 0023). Computed by code and free of text, so an
 * injection in a read cannot survive the restart. Items already delegated are remembered by the
 * `delegate` tool itself, which outlives the restart.
 */
export const ProgressState = z.strictObject({
  calls: z.array(ToolCallRecord).max(500),
  restarts: z.number().int().min(0).max(2),
});
export type ProgressState = z.infer<typeof ProgressState>;

/**
 * A read of one target in this run, with the snapshot code built from it: an issue's, or a pull
 * request's with its head SHA and reviews (ADR 0024), so a push after the read turns the write
 * into a no-op.
 */
export type TargetRead =
  | { target: ProposalTarget & { kind: 'issue' }; snapshot: IssueSnapshot }
  | { target: ProposalTarget & { kind: 'pull' }; snapshot: PullSnapshot };
