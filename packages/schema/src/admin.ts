import { z } from 'zod';
import { AgentId, AgentManifest, KillSwitchState, SemVer } from './agent.js';
import { Trigger } from './broker.js';
import { BrokerAction, GitHubLogin } from './actions.js';

export const AgentSummary = z.object({
  manifest: AgentManifest,
  killSwitch: KillSwitchState,
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired']);

/**
 * An issue as triage-apply saw it when it asked for an approval (ADR 0019). The broker reads the
 * issue again before running a bundle and refuses it if any field differs.
 */
export const IssueSnapshot = z.object({
  state: z.enum(['open', 'closed']),
  /** Sorted. */
  labels: z.array(z.string().min(1).max(50)).max(100),
  /** Sorted. */
  assignees: z.array(GitHubLogin).max(10),
  comments: z.number().int().min(0).max(100_000),
});
export type IssueSnapshot = z.infer<typeof IssueSnapshot>;

/** Actions a bundle may hold, in the order they run: idempotent first, the comment last. */
export const BUNDLE_ORDER = [
  'issue.assign',
  'issue.label.add',
  'issue.label.remove',
  'issue.comment',
] as const;

/**
 * Several actions on one issue under one approval (ADR 0019): approved or rejected together, run
 * in BUNDLE_ORDER (each type at most once), and only if the issue still matches `snapshot`.
 */
export const ApprovalBundle = z
  .object({
    actions: z.array(BrokerAction).min(1).max(4),
    snapshot: IssueSnapshot,
  })
  .refine(
    (b) => {
      const types = b.actions.map((a) => a.type);
      const order = types.map((t) => (BUNDLE_ORDER as readonly string[]).indexOf(t));
      return order.every((i, k) => i >= 0 && (k === 0 || i > (order[k - 1] ?? -1)));
    },
    { message: 'bundle actions must be issue actions in BUNDLE_ORDER, each at most once' },
  )
  .refine(
    (b) => {
      const first = b.actions[0];
      return b.actions.every(
        (a) =>
          'issue' in a &&
          first &&
          'issue' in first &&
          a.repo === first.repo &&
          a.issue === first.issue,
      );
    },
    { message: 'every bundle action must target the same issue' },
  );
export type ApprovalBundle = z.infer<typeof ApprovalBundle>;

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

/** The broker's answer to an agent asking for an approval: the request and its link token. */
export const ApprovalCreated = z.object({
  approval: ApprovalRequest,
  /** `<approvalId>.<exp>.<hmac>`, bound to this approval's exact action (ADR 0017 amendment). */
  token: z.string().regex(/^[0-9a-f-]{36}\.\d{1,12}\.[A-Za-z0-9_-]{20,100}$/),
});
export type ApprovalCreated = z.infer<typeof ApprovalCreated>;

export const HaltRequest = z.object({ reason: z.string().min(3).max(500) });

export const AdminActor = z.object({
  /** Email from the Cloudflare Access JWT, or `service:<token-name>` for service tokens. */
  subject: z.string(),
  via: z.enum(['access-user', 'access-service-token']),
});
export type AdminActor = z.infer<typeof AdminActor>;
