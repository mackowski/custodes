import { z } from 'zod';
import { AgentId, SemVer } from './agent.js';
import { BrokerResponse, Trigger } from './broker.js';
import { BrokerAction, BrokerActionType } from './actions.js';
import { IssueSnapshot, PullSnapshot } from './snapshots.js';

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired']);

export { IssueSnapshot, PullSnapshot } from './snapshots.js';

/**
 * Actions a bundle may hold, in the order they run (ADR 0024): idempotent state first, then the
 * comment, then the action that closes the thread, which is always last.
 */
export const BUNDLE_ORDER = [
  'issue.assign',
  'issue.unassign',
  'issue.label.add',
  'issue.label.remove',
  'issue.comment',
  'issue.close',
  'pr.close',
] as const;

/** The issue or pull request number an action is about. */
export function numberOf(a: BrokerAction): number {
  return 'pull' in a ? a.pull : a.issue;
}

/**
 * Several actions on one issue or pull request under one approval (ADR 0019, generalised by
 * ADR 0024): approved or rejected together, run in BUNDLE_ORDER (each type at most once), and only
 * if the target still matches `snapshot`. A `PullSnapshot` makes the target a pull request.
 */
export const ApprovalBundle = z
  .object({
    actions: z.array(BrokerAction).min(1).max(BUNDLE_ORDER.length),
    // Pull first: the issue snapshot is strict, so the order only decides which error is shown.
    snapshot: z.union([PullSnapshot, IssueSnapshot]),
  })
  .refine(
    (b) => {
      const types = b.actions.map((a) => a.type);
      const order = types.map((t) => (BUNDLE_ORDER as readonly string[]).indexOf(t));
      return order.every((i, k) => i >= 0 && (k === 0 || i > (order[k - 1] ?? -1)));
    },
    { message: 'bundle actions must be in BUNDLE_ORDER, each at most once' },
  )
  .refine(
    (b) => {
      const first = b.actions[0];
      return (
        first !== undefined &&
        b.actions.every((a) => a.repo === first.repo && numberOf(a) === numberOf(first))
      );
    },
    { message: 'every bundle action must target the same issue or pull request' },
  )
  .refine(
    (b) => {
      const pull = 'headSha' in b.snapshot;
      // An issue is closed with issue.close, a pull request with pr.close; never the other way.
      return b.actions.every((a) => (pull ? a.type !== 'issue.close' : a.type !== 'pr.close'));
    },
    { message: 'the closing action must match the target kind' },
  );
export type ApprovalBundle = z.infer<typeof ApprovalBundle>;

/** Whether a bundle is about a pull request (it carries a `PullSnapshot`). */
export function isPullBundle(b: ApprovalBundle): b is ApprovalBundle & { snapshot: PullSnapshot } {
  return 'headSha' in b.snapshot;
}

/** An agent asking for one approval of a bundle (POST /v1/approvals/bundle, ADR 0019). */
export const BundleApprovalAsk = z.object({
  request: z.object({
    agentId: AgentId,
    agentVersion: SemVer,
    runId: z.uuid(),
    triggeredBy: Trigger,
    bundle: ApprovalBundle,
  }),
  rationale: z.string().max(4000),
});
export type BundleApprovalAsk = z.infer<typeof BundleApprovalAsk>;

export const ApprovalRequest = z.object({
  id: z.uuid(),
  agentId: AgentId,
  runId: z.uuid(),
  action: BrokerAction,
  /** Human-readable rationale produced by the agent. Untrusted: may contain model output. */
  rationale: z.string().max(4000),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  status: ApprovalStatus,
  decidedBy: z.string().optional(),
  decidedAt: z.iso.datetime().optional(),
  /** Set for a bundle (ADR 0019); `action` is then its first action. */
  bundle: ApprovalBundle.optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** `<approval id>.<expiry>.<mac>`: the token in an approval link. One definition for every check. */
export const ApprovalToken = z.string().regex(/^[0-9a-f-]{36}\.\d{1,12}\.[A-Za-z0-9_-]{20,100}$/);

/** The broker's answer to an agent asking for an approval: the request and its link token. */
export const ApprovalCreated = z.object({
  approval: ApprovalRequest,
  /** `<approvalId>.<exp>.<hmac>`, bound to this approval's exact action (ADR 0017 amendment). */
  token: ApprovalToken,
});
export type ApprovalCreated = z.infer<typeof ApprovalCreated>;

/** One action of an approved bundle, as it ran (or did not). */
export const BundleStep = z.object({
  type: BrokerActionType,
  outcome: z.enum(['done', 'failed', 'not_run']),
  code: z.string().optional(),
  githubUrl: z.string().optional(),
});
export type BundleStep = z.infer<typeof BundleStep>;

/**
 * The broker's answer to a decision on an approval (the link page and the CLI's reject). The
 * gateway parses it: a reply that is not one of these is an unknown outcome, never "nothing done".
 */
export const DecideOutcome = z.union([
  z.object({ result: z.enum(['not_found', 'not_pending', 'expired', 'rate_limited']) }),
  z.object({ result: z.literal('ok'), decision: z.literal('rejected') }),
  z.object({
    result: z.literal('ok'),
    decision: z.literal('approved'),
    executed: BrokerResponse,
    steps: z.array(BundleStep).optional(),
  }),
]);
export type DecideOutcome = z.infer<typeof DecideOutcome>;

export const HaltRequest = z.object({ reason: z.string().min(3).max(500) });

export const AdminActor = z.object({
  /** Email from the Cloudflare Access JWT, or `service:<token-name>` for service tokens. */
  subject: z.string(),
  via: z.enum(['access-user', 'access-service-token']),
});
export type AdminActor = z.infer<typeof AdminActor>;
