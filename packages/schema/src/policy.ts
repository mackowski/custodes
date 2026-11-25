import { z } from 'zod';
import { AgentId, AgentMode, GitHubRepo } from './agent.js';
import { BrokerActionType, GitHubLogin } from './actions.js';
import { ReadResource } from './read.js';
import { ACTION_REGISTRY, Tier, highestTier } from './tiers.js';

/**
 * `$comment` and `$comment_<field>` are the only keys a policy may carry besides its fields; they
 * are dropped before the strict parse. Any other unknown key fails, so a misspelt field (say
 * `requiresAprovalOn`) cannot be silently ignored (ADR 0022).
 */
const COMMENT_KEY = /^\$comment(_[A-Za-z][A-Za-z0-9]*)?$/;
function withoutComments(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  // Only string comments are dropped: an object under `$comment_requiresApprovalOn` would look like
  // the field in a raw diff while the schema ignored it (security review of #139, L1).
  return Object.fromEntries(
    Object.entries(value).filter(([k, v]) => !(COMMENT_KEY.test(k) && typeof v === 'string')),
  );
}

/** Broker defaults when a policy leaves these out; the boundary check uses the same values. */
export const DEFAULT_APPROVAL_TTL_HOURS = 24;
export const DEFAULT_MAX_PENDING_APPROVALS = 20;

/**
 * Labels that start automation when added from the operator's account: `custodes_cheatsheet_review`
 * (cheatsheet-review, ADR 0017) and `jules` (Google Jules on OWASP, which then pushes a branch and
 * opens a PR as the operator). No agent that labels from the operator's account may add them, and
 * proposals never suggest them (ADR 0019; security review of #113). Compared case-insensitively.
 */
export const AUTOMATION_TRIGGER_LABELS: readonly string[] = ['custodes_cheatsheet_review', 'jules'];

/**
 * The only exceptions to `AUTOMATION_TRIGGER_LABELS` (ADR 0024): agent id → trigger labels it may
 * add. In code, not in `policy.json`, so a new exception is a reviewed code change and cannot be
 * copied into another agent's `labels`. `jules` is never granted: it pushes code as the operator.
 */
export const TRIGGER_LABEL_GRANTS: Readonly<Record<string, readonly string[]>> = {
  'backlog-review': ['custodes_cheatsheet_review'],
};

/** Adds of one trigger label per agent and repository in a rolling day (ADR 0024). */
export const TRIGGER_LABEL_DAILY_CAP = 3;

/** Whether `label` starts automation (case-insensitive, as GitHub compares label names). */
export function isTriggerLabel(label: string): boolean {
  return AUTOMATION_TRIGGER_LABELS.some((t) => t.toLowerCase() === label.toLowerCase());
}

/** Whether this agent may add this trigger label (always false for any other label's caller). */
export function mayAddTriggerLabel(agentId: string, label: string): boolean {
  const granted = Object.hasOwn(TRIGGER_LABEL_GRANTS, agentId) ? TRIGGER_LABEL_GRANTS[agentId] : [];
  return (granted ?? []).some((l) => l.toLowerCase() === label.toLowerCase());
}

/**
 * The only repository where an agent-started review may post without the operator's approval
 * (ADR 0024). Everywhere else a trigger-label grant needs cheatsheet-review's approval: an agent's
 * label is indistinguishable from the operator's, so that approval keeps an agent-started review
 * from posting unseen.
 */
export const REVIEW_SANDBOX_REPO = 'mackowski/custodes-sandbox';

const AgentPolicyObject = z
  .strictObject({
    /** Name of the Secrets Store binding that holds this agent's GitHub PAT. */
    tokenBinding: z.string().regex(/^PAT_[A-Z0-9_]+$/),
    mode: AgentMode,
    /**
     * Declared trust tier (ADR 0021). Must equal the highest tier of `actions`
     * (`ACTION_REGISTRY`), so granting a higher-tier action is a visible tier change.
     */
    tier: Tier,
    repos: z.array(GitHubRepo).min(1),
    actions: z.array(BrokerActionType).min(1),
    /** Subset of `actions` that always needs an approval id, even for hotl agents. */
    requiresApproval: z.array(BrokerActionType).default([]),
    /**
     * Per repository: actions that need an approval id there, on top of `requiresApproval`. A repo
     * may be listed before it is in `repos`, so a later widening already comes with its approval
     * (ADR 0017 amendment: cheatsheet-review publishes on OWASP only after the operator's click).
     */
    requiresApprovalOn: z.record(GitHubRepo, z.array(BrokerActionType).min(1)).default({}),
    /**
     * Max side effects per rolling hour **per repository**; the broker denies above this. Each repo
     * in `repos` gets its own budget, so adding a repo widens the agent's total (ADR 0012).
     */
    rateLimitPerHour: z.number().int().positive().default(60),
    /**
     * When set, `issue.label.add` and `issue.label.remove` may only name these labels. Without it,
     * a label grant covers every label in the repository.
     */
    labels: z.array(z.string().min(1).max(50)).min(1).optional(),
    /**
     * How long this agent's approval requests stay open; the broker default is 24 h. Longer is a
     * widening (invariant 4): triage-apply's 168 h follows ADR 0019 (a daily digest read weekly).
     */
    approvalTtlHours: z.number().int().min(1).max(336).optional(),
    /** Pending approval requests at once; the broker default is 20 (ADR 0019 for triage-apply). */
    maxPendingApprovals: z.number().int().min(1).max(200).optional(),
    /**
     * `hidden`: comments carry only the HTML-comment trailer (agent and attestation id, read by
     * /verify) and no visible footer. Operator decision for triage-apply (#108).
     */
    trailer: z.enum(['visible', 'hidden']).default('visible'),
    /**
     * Only bundle approvals (ADR 0019): the plain one-action approval route refuses this agent, so
     * every request goes through the bundle checks (snapshot, thread people). Which targets it can
     * bundle (issues, pull requests) follows from its actions and read policy (ADR 0024).
     * `true` → `false` is a widening (invariant 4).
     */
    bundleOnly: z.boolean().default(false),
  })
  .refine(
    (a) =>
      a.labels !== undefined ||
      !a.actions.some((t) => t === 'issue.label.add' || t === 'issue.label.remove'),
    { message: 'a label action needs a labels allow-list', path: ['labels'] },
  )
  .refine((a) => a.trailer === 'visible' || (a.mode === 'hitl' && a.bundleOnly), {
    // A hidden trailer makes model-drafted text look like the operator's own words: only behind
    // an approval of the exact bundle (ADR 0019, Claude review of #106).
    message: 'trailer "hidden" needs mode "hitl" and bundleOnly',
    path: ['trailer'],
  })
  .refine(
    (a) =>
      Object.values(a.requiresApprovalOn).every((list) => list.every((t) => a.actions.includes(t))),
    {
      message: 'requiresApprovalOn may only name actions the agent has',
      path: ['requiresApprovalOn'],
    },
  )
  .refine(
    (a) =>
      a.mode === 'hitl' ||
      a.actions.every(
        (t) => ACTION_REGISTRY[t].risk !== 'critical' || a.requiresApproval.includes(t),
      ),
    {
      // ADR 0022 recorded risk; ADR 0024 makes "critical" mean "always behind an approval".
      message: 'a critical action needs an approval on every repository (requiresApproval)',
      path: ['requiresApproval'],
    },
  )
  .refine((a) => a.tier === highestTier(a.actions), {
    message: "tier must equal the highest tier of the agent's actions (ACTION_REGISTRY, ADR 0021)",
    path: ['tier'],
  });
export const AgentPolicy = z.preprocess(withoutComments, AgentPolicyObject);
export type AgentPolicy = z.infer<typeof AgentPolicy>;

/** Read access through the broker: GET-only, allow-listed resources, with a read-only token. */
export const ReadPolicy = z.preprocess(
  withoutComments,
  z.strictObject({
    /** Secrets Store binding holding a PAT limited to public repositories, read-only. */
    tokenBinding: z.string().regex(/^PAT_[A-Z0-9_]+$/),
    repos: z.array(GitHubRepo).min(1),
    /** The only resources this agent may read. Explicit, so a new resource is never granted by default. */
    resources: z.array(ReadResource).min(1),
  }),
);
export type ReadPolicy = z.infer<typeof ReadPolicy>;

export const Policy = z.preprocess(
  withoutComments,
  z
    .strictObject({
      version: z.literal(1),
      agents: z.record(AgentId, AgentPolicy),
      reads: z.record(AgentId, ReadPolicy).default({}),
      /**
       * Per repository: maintainers an agent's comment may @-mention besides the thread's author and
       * commenters (ADR 0024). Changed only by a reviewed policy pull request; a login missing here
       * cannot be pinged, which fails safe.
       */
      maintainers: z.record(GitHubRepo, z.array(GitHubLogin).max(30)).default({}),
    })
    .refine(
      // Only adding starts automation: cheatsheet-review lists its own label to remove it.
      (p) =>
        Object.entries(p.agents).every(
          ([id, a]) =>
            !a.actions.includes('issue.label.add') ||
            (a.labels ?? []).every((l) => !isTriggerLabel(l) || mayAddTriggerLabel(id, l)),
        ),
      {
        message: 'a trigger label (AUTOMATION_TRIGGER_LABELS) needs a TRIGGER_LABEL_GRANTS entry',
        path: ['agents'],
      },
    )
    .refine(
      (p) =>
        // Every repository where a granted agent can add the label and cheatsheet-review runs,
        // except the sandbox, keeps the approval (security review of #143, finding 4).
        Object.entries(p.agents).every(([id, a]) => {
          if (!a.actions.includes('issue.label.add')) return true;
          if (!(a.labels ?? []).some((l) => mayAddTriggerLabel(id, l))) return true;
          const review = p.agents['cheatsheet-review'];
          if (!review) return true;
          return a.repos
            .filter((r) => r !== REVIEW_SANDBOX_REPO && review.repos.includes(r))
            .every(
              (r) =>
                review.mode === 'hitl' ||
                review.requiresApproval.includes('pr.review.inline') ||
                (review.requiresApprovalOn[r]?.includes('pr.review.inline') ?? false),
            );
        }),
      {
        message:
          "a trigger-label grant needs cheatsheet-review's approval on every shared repository but the sandbox (ADR 0024)",
        path: ['agents'],
      },
    ),
);
export type Policy = z.infer<typeof Policy>;
