/**
 * The runtime host (ADR 0023, #140a slice 3): ties the loop, `delegate`, the dispatcher and the
 * run store to one agent, and executes the routes. An agent passes its own primitives as a port
 * (`CustodesAgent` keeps `act`, the approvals and the broker private to the agent), so nothing here
 * holds a credential or calls GitHub: every read and write still goes through the broker.
 */
import {
  issueThreadFrom,
  MAX_HOTL_WRITES_PER_TREE,
  pullThreadFrom,
  readAllPages,
  routeProposal,
  runGuard,
  storeLedger,
  type EvidenceChecker,
  type Route,
  type RunStore,
} from '@custodes/core';
import {
  ApprovalBundle,
  BUNDLE_ORDER,
  CheatSheetFile,
  CheatSheetSearch,
  Proposal,
  ReadQuery,
  type AgentDefinition,
  type BrokerAction,
  type BrokerReadRequest,
  type BrokerResponse,
  type IssueSnapshot,
  type PullSnapshot,
  ProposalList,
  type Policy,
  type ProposalTarget,
  type ReadResource,
  type TargetRead,
} from '@custodes/schema';
import { z } from 'zod';
import { childTools, delegateTool, type ChildOutcome } from './delegate.js';
import type { MessagesRequest, MessagesResponse } from './gateway.js';
import { defineTool, runWithRestarts, type LoopResult, type RuntimeTool } from './runtime.js';

/** A read through the broker's `/v1/read` for one run: its data, or why it failed (no error text). */
export type ReadFn = (
  runId: string,
  req: Omit<BrokerReadRequest, 'agentId' | 'runId'>,
) => Promise<{ ok: true; data: unknown } | { ok: false; reason: string }>;

/** What the agent lends the host. Each method is the agent's own, broker-backed primitive. */
export interface HostPort {
  agentId: string;
  /**
   * The bundled broker policy: the dispatcher routes with it, the broker still decides.
   * shortcut: a copy older than the broker's can only drop or misroute an action (the broker
   * answers approval_required, or refuses an approval that needs none): never widen. Both answers
   * show in the run's outcomes; the agent redeploys with every policy change (deploy-workers.yml).
   */
  policy: Policy;
  /** The agent's read policy: its repositories and resources. */
  repos: readonly [string, ...string[]];
  resources: readonly ReadResource[];
  store: RunStore;
  /** `CustodesAgent.guard()`: the agent and fleet kill switch through the broker. */
  brokerGuard(): Promise<void>;
  read: ReadFn;
  send(req: MessagesRequest): Promise<MessagesResponse>;
  costOf(usage: MessagesResponse['usage']): number;
  /**
   * `CustodesAgent.act()`. The first write on a target carries the route's snapshot; later writes
   * of the same proposal do not, because the first one changed the target (ADR 0023).
   */
  act(
    action: BrokerAction,
    runId: string,
    snapshot?: IssueSnapshot | PullSnapshot,
  ): Promise<BrokerResponse>;
  requestBundle(bundle: ApprovalBundle, rationale: string, runId: string): Promise<{ ok: boolean }>;
  requestApproval(
    action: BrokerAction,
    rationale: string,
    runId: string,
    snapshot: IssueSnapshot | PullSnapshot,
  ): Promise<{ ok: boolean }>;
  now?: () => Date;
}

/** One bundled agent.md: its frontmatter and its system prompt. */
export interface BundledAgent {
  definition: AgentDefinition;
  prompt: string;
}

/** What happened to one routed action. */
export interface Outcome {
  runId: string;
  target: ProposalTarget;
  action: BrokerAction['type'];
  route: Route['route'];
  /** Drop reason, or the broker's answer for act and approval. */
  detail: string;
}

export interface TreeResult {
  rootRunId: string;
  status: 'done' | 'stopped' | 'escalated';
  stop?: string;
  outcomes: Outcome[];
  /** Digest routes (shadow, readonly or no policy entry), with their snapshot. */
  digest: Route[];
}

const MAX_OUTPUT_TOKENS = 8_000;

/**
 * The read tools of one run, one per resource the agent's read policy grants and its agent.md
 * lists. `issue` and `pull` also read the thread and name the target with the snapshot the broker
 * will check (`@custodes/core` builds both), so the dispatcher can route the write.
 */
export function readTools(
  port: Pick<HostPort, 'repos' | 'resources' | 'read'>,
  runId: string,
  names: readonly string[],
): RuntimeTool[] {
  const repo = z.enum(port.repos);
  const read = (req: Omit<BrokerReadRequest, 'agentId' | 'runId'>) => port.read(runId, req);
  const pages = (r: string, number: number, resource: 'comments' | 'pull_reviews') =>
    readAllPages((page) => read({ repo: r, resource, number, query: { per_page: 100, page } }));
  const text = (data: unknown) => JSON.stringify(data);
  /**
   * The fields the model decides on, not GitHub's raw JSON: user objects and URLs would fill the
   * 40k clip and hide the newest comments (lean review of #166 slice 3). Snapshots are still built
   * from the raw data.
   */
  type Raw =
    | {
        number?: unknown;
        title?: unknown;
        state?: unknown;
        labels?: unknown;
        user?: unknown;
        created_at?: unknown;
        updated_at?: unknown;
        merged_at?: unknown;
        submitted_at?: unknown;
        body?: unknown;
      }
    | null
    | undefined;
  const login = (u: unknown) => (u as { login?: unknown } | null | undefined)?.login ?? null;
  const labelNames = (l: unknown) =>
    Array.isArray(l)
      ? l.map((x) => (typeof x === 'string' ? x : ((x as { name?: unknown } | null)?.name ?? null)))
      : [];
  const item = (d: unknown) => {
    const x = d as Raw;
    return {
      number: x?.number ?? null,
      title: x?.title ?? null,
      state: x?.state ?? null,
      labels: labelNames(x?.labels),
      author: login(x?.user),
      created_at: x?.created_at ?? null,
      updated_at: x?.updated_at ?? null,
      ...(x?.merged_at !== undefined ? { merged_at: x.merged_at } : {}),
      body: x?.body ?? null,
    };
  };
  const comment = (d: unknown) => {
    const x = d as Raw;
    return { author: login(x?.user), created_at: x?.created_at ?? null, body: x?.body ?? null };
  };
  const review = (d: unknown) => {
    const x = d as Raw;
    return {
      author: login(x?.user),
      state: x?.state ?? null,
      submitted_at: x?.submitted_at ?? null,
      body: x?.body ?? null,
    };
  };
  const failed = (reason: string) => ({ content: `read failed: ${reason}` });
  const numbered = z.strictObject({
    repo,
    number: z.number().int().positive(),
    page: ReadQuery.shape.page,
  });
  const listed = z.strictObject({
    repo,
    page: ReadQuery.shape.page,
    state: ReadQuery.shape.state,
  });

  const all: Partial<Record<ReadResource, RuntimeTool>> = {
    issue: defineTool({
      name: 'issue',
      description: 'Read one issue with all its comments.',
      args: z.strictObject({ repo, number: z.number().int().positive() }),
      async run({ repo: r, number }) {
        const got = await read({ repo: r, resource: 'issue', number, query: {} });
        if (!got.ok) return failed(got.reason);
        const comments = await pages(r, number, 'comments');
        if (!comments.ok) return failed(comments.reason);
        const thread = await issueThreadFrom(got.data, comments.items);
        const content = text({ issue: item(got.data), comments: comments.items.map(comment) });
        if (!thread.ok) return { content };
        const read_: TargetRead = {
          target: { repo: r, kind: 'issue', number },
          snapshot: thread.snapshot,
        };
        return { content, read: read_ };
      },
    }),
    pull: defineTool({
      name: 'pull',
      description: 'Read one pull request with its conversation and reviews.',
      args: z.strictObject({ repo, number: z.number().int().positive() }),
      async run({ repo: r, number }) {
        const got = await read({ repo: r, resource: 'pull', number, query: {} });
        if (!got.ok) return failed(got.reason);
        const comments = await pages(r, number, 'comments');
        if (!comments.ok) return failed(comments.reason);
        const reviews = await pages(r, number, 'pull_reviews');
        if (!reviews.ok) return failed(reviews.reason);
        const thread = await pullThreadFrom(got.data, comments.items, reviews.items);
        const content = text({
          pull: item(got.data),
          comments: comments.items.map(comment),
          reviews: reviews.items.map(review),
        });
        if (!thread.ok) return { content };
        const read_: TargetRead = {
          target: { repo: r, kind: 'pull', number },
          snapshot: thread.snapshot,
        };
        return { content, read: read_ };
      },
    }),
    cheatsheet: defineTool({
      name: 'cheatsheet',
      description: 'Read one cheat sheet from the default branch.',
      args: z.strictObject({ repo, file: CheatSheetFile }),
      async run({ repo: r, file }) {
        const got = await read({ repo: r, resource: 'cheatsheet', file, query: {} });
        return got.ok ? { content: text(got.data) } : failed(got.reason);
      },
    }),
    cheatsheet_search: defineTool({
      name: 'cheatsheet_search',
      description: 'Search the cheat sheets by words (no operators).',
      args: z.strictObject({ repo, search: CheatSheetSearch }),
      async run({ repo: r, search }) {
        const got = await read({ repo: r, resource: 'cheatsheet_search', search, query: {} });
        return got.ok ? { content: text(got.data) } : failed(got.reason);
      },
    }),
  };
  const shape: Partial<Record<ReadResource, (d: unknown) => unknown>> = {
    comments: comment,
    pull_reviews: review,
  };
  for (const resource of ['timeline', 'comments', 'pull_files', 'pull_reviews'] as const)
    all[resource] = defineTool({
      name: resource,
      description: `Read the ${resource.replace('_', ' ')} of one issue or pull request (one page).`,
      args: numbered,
      async run({ repo: r, number, page }) {
        const query = page === undefined ? {} : { page };
        const got = await read({ repo: r, resource, number, query });
        if (!got.ok) return failed(got.reason);
        const f = shape[resource];
        return { content: text(f && Array.isArray(got.data) ? got.data.map(f) : got.data) };
      },
    });
  for (const resource of ['issues', 'pulls', 'labels', 'cheatsheets'] as const)
    all[resource] = defineTool({
      name: resource,
      description: `List ${resource} (one page).`,
      args: listed,
      async run({ repo: r, page, state }) {
        const query = {
          ...(page === undefined ? {} : { page }),
          ...(state === undefined ? {} : { state }),
        };
        const got = await read({ repo: r, resource, query });
        return got.ok ? { content: text(got.data) } : failed(got.reason);
      },
    });

  // Only what the read policy grants and the agent.md lists: the broker would refuse the rest.
  return names
    .filter((n): n is ReadResource => (port.resources as readonly string[]).includes(n))
    .flatMap((n) => {
      const t = all[n];
      return t ? [t] : [];
    });
}

/**
 * Evidence an action needs, checked again through the broker (ADR 0023). Never defaults to ok for
 * an action that needs evidence: a missing, unknown or unreadable one drops the action.
 * `issue.close` needs a merged pull request of the same repository that the issue's timeline
 * cross-references AND whose own title or body names the issue: anyone can create a
 * cross-reference by commenting "#7" elsewhere, but only a merged PR's author wrote its text
 * (security review of #166 slice 3, M2).
 */
export function brokerEvidence(
  read: (req: Omit<BrokerReadRequest, 'agentId' | 'runId'>) => ReturnType<ReadFn>,
): EvidenceChecker {
  return async (action, proposal) => {
    if (action.type !== 'issue.close') return { ok: true };
    const refs = proposal.evidence
      .filter((e) => e.type === 'merged_pr')
      .map((e) => /^#(\d{1,7})$/.exec(e.ref)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    if (refs.length === 0) return { ok: false, reason: 'issue.close needs a merged_pr' };
    const timeline = await readAllPages((page) =>
      read({
        repo: action.repo,
        resource: 'timeline',
        number: action.issue,
        query: { per_page: 100, page },
      }),
    );
    if (!timeline.ok) return { ok: false, reason: 'evidence unreadable' };
    for (const n of refs) {
      const referenced = timeline.items.some((e) => {
        const ev = e as {
          event?: unknown;
          source?: {
            issue?: {
              number?: unknown;
              pull_request?: unknown;
              repository?: { full_name?: unknown };
            };
          };
        };
        const src = ev.source?.issue;
        const full = src?.repository?.full_name;
        // A missing repository fails closed.
        const sameRepo =
          typeof full === 'string' && full.toLowerCase() === action.repo.toLowerCase();
        return (
          ev.event === 'cross-referenced' &&
          src?.number === n &&
          src.pull_request !== undefined &&
          sameRepo
        );
      });
      if (!referenced) continue;
      const pull = await read({ repo: action.repo, resource: 'pull', number: n, query: {} });
      if (!pull.ok) return { ok: false, reason: 'evidence unreadable' };
      const pr = pull.data as { merged_at?: unknown; title?: unknown; body?: unknown } | null;
      const merged = pr?.merged_at;
      if (typeof merged !== 'string' || merged.length === 0) continue;
      const own = `${typeof pr?.title === 'string' ? pr.title : ''}\n${typeof pr?.body === 'string' ? pr.body : ''}`;
      if (namesIssue(own, action.repo, action.issue)) return { ok: true };
    }
    return { ok: false, reason: 'no merged pull request references the issue' };
  };
}

/** Whether text names the issue as `#N` or `owner/repo#N` (not as part of a longer number). */
export function namesIssue(text: string, repo: string, issue: number): boolean {
  const n = String(issue);
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`(^|[^\\w/])#${n}(?!\\d)`).test(text) ||
    new RegExp(`(^|\\W)${escaped}#${n}(?!\\d)`, 'i').test(text)
  );
}

/**
 * Runs one agent tree: the root run, its children through `delegate`, every proposal through the
 * dispatcher, and every route executed. The run guard is checked again immediately before each
 * direct write (threat model, "must hold"); every write and approval carries the store's run id.
 */
export async function runAgentTree(
  port: HostPort,
  root: BundledAgent,
  roles: Readonly<Record<string, BundledAgent>>,
  task: string,
  opts: { shadow: boolean },
): Promise<TreeResult> {
  const { store, agentId } = port;
  const now = port.now ?? (() => new Date());
  const rootRunId = store.start(agentId);
  const outcomes: Outcome[] = [];
  const digest: Route[] = [];

  const run = async (
    runId: string,
    agent: BundledAgent,
    runTask: string,
    tools: RuntimeTool[],
    output: z.ZodType,
  ): Promise<
    LoopResult<unknown> | ({ ok: false; stop: 'escalate' } & Omit<LoopResult<unknown>, 'ok'>)
  > => {
    const d = agent.definition;
    // A throw (transport, a read, the store) ends this run, not the tree: earlier children's
    // outcomes and digest stay (lean review of #166 slice 3). The stop is an enum, never error text.
    const failed = (): { ok: false; stop: 'error' } & Omit<LoopResult<unknown>, 'ok'> => ({
      ok: false,
      stop: 'error',
      progress: { calls: [], restarts: 0 },
      reads: [],
      usd: 0,
      rounds: 0,
    });
    let result: Awaited<ReturnType<typeof runWithRestarts>>;
    try {
      result = await runWithRestarts(
        {
          model: d.model,
          system: agent.prompt,
          task: runTask,
          tools,
          output,
          caps: { rounds: d.budget.roundsPerRun, usd: d.budget.usdPerRun },
          maxTokens: MAX_OUTPUT_TOKENS,
          metadata: { agentId, runId },
        },
        {
          send: (req) => port.send(req),
          guard: runGuard(store, runId, () => port.brokerGuard()),
          costOf: (u) => port.costOf(u),
          daily: { ledger: storeLedger(store, agentId, runId, now), usd: d.budget.usdPerDay },
          record: (e) => {
            store.recordEvent({ runId, ...e });
          },
        },
      );
    } catch {
      try {
        store.finish(runId, 'stopped');
      } catch {
        // The store itself failed: the run stays open until the 14-day prune.
      }
      return failed();
    }
    store.finish(runId, result.ok ? 'done' : result.stop === 'escalate' ? 'escalated' : 'stopped');
    return result;
  };

  /** True once a guard refused: the tree stops writing and asking (ADR 0023 run-scoped kill). */
  const tree = { halted: false };

  const dispatch = async (runId: string, proposal: Proposal, reads: readonly TargetRead[]) => {
    const guard = runGuard(store, runId, () => port.brokerGuard());
    const record = (r: Route, detail: string) =>
      outcomes.push({
        runId,
        target: proposal.target,
        action: r.action.type,
        route: r.route,
        detail,
      });
    /** The run guard, right before a write or a request: a kill since routing stops it. */
    const stillAllowed = async () => {
      if (tree.halted) return false;
      try {
        await guard();
        return true;
      } catch {
        tree.halted = true;
        return false;
      }
    };
    if (!(await stillAllowed())) return;
    let routes: Route[];
    try {
      routes = await routeProposal({
        policy: port.policy,
        agentId,
        proposal,
        reads,
        shadow: opts.shadow,
        checkEvidence: brokerEvidence((req) => port.read(runId, req)),
        guard,
        takeHotlSlot: () => store.takeHotlSlot(runId, MAX_HOTL_WRITES_PER_TREE),
      });
    } catch {
      // The dispatcher's own guard refused (or an evidence read threw): nothing is routed.
      tree.halted = true;
      return;
    }

    /** A port call that throws halts the tree; the outcome says `error`, never its text. */
    const attempt = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await call();
      } catch {
        tree.halted = true;
        return undefined;
      }
    };
    const approvals = routes.filter(
      (r): r is Exclude<Route, { route: 'drop' }> => r.route === 'approval',
    );
    const order = (t: string) => (BUNDLE_ORDER as readonly string[]).indexOf(t);
    const acts = routes
      .filter((r): r is Exclude<Route, { route: 'drop' }> => r.route === 'act')
      .sort((a, b) => order(a.action.type) - order(b.action.type));
    for (const r of routes) {
      if (r.route === 'drop') record(r, r.reason);
      else if (r.route === 'digest') {
        digest.push(r);
        record(r, 'digest');
      }
    }
    // Direct writes in bundle order (the closing one last). Only the first carries the snapshot:
    // the first write changes the target, so the later ones would always look stale. They still
    // pass the broker's people and comment rules (ADR 0023; reviews of #166 slice 3, L1).
    for (const [i, r] of acts.entries()) {
      if (!(await stillAllowed())) {
        record(r, 'halted');
        continue;
      }
      const res = await attempt(() =>
        i === 0 ? port.act(r.action, runId, r.snapshot) : port.act(r.action, runId),
      );
      record(r, res === undefined ? 'error' : res.ok ? 'ok' : res.code);
    }
    if (approvals.length === 0) return;
    if (!(await stillAllowed())) {
      for (const r of approvals) record(r, 'halted');
      return;
    }
    // One approval for the actions on this target when they form a bundle (ADR 0019, 0024).
    const bundle = ApprovalBundle.safeParse({
      actions: [...approvals]
        .sort((a, b) => order(a.action.type) - order(b.action.type))
        .map((r) => r.action),
      snapshot: approvals[0]?.snapshot,
    });
    if (bundle.success) {
      const res = await attempt(() => port.requestBundle(bundle.data, proposal.reason, runId));
      for (const r of approvals)
        record(r, res === undefined ? 'error' : res.ok ? 'approval requested' : 'approval refused');
      return;
    }
    for (const r of approvals) {
      if (tree.halted) {
        record(r, 'halted');
        continue;
      }
      const res = await attempt(() =>
        port.requestApproval(r.action, proposal.reason, runId, r.snapshot),
      );
      record(r, res === undefined ? 'error' : res.ok ? 'approval requested' : 'approval refused');
    }
  };

  const tools = readTools(port, rootRunId, root.definition.tools);
  if (root.definition.agents.length > 0 && root.definition.tools.includes('delegate')) {
    const [first, ...rest] = root.definition.agents;
    if (first !== undefined)
      tools.push(
        delegateTool({
          roles: [first, ...rest],
          repos: port.repos,
          async runChild(role, target): Promise<ChildOutcome> {
            const child = roles[role];
            if (!child) return { ok: false, stop: 'undeclared_tool' };
            const childId = store.start(agentId, rootRunId);
            // The child's task is built by code from the role and the target: no parent text.
            const childTask = `Assess ${target.kind} #${String(target.number)} in ${target.repo} as ${role}. Read it first, then answer with one proposal.`;
            const r = await run(
              childId,
              child,
              childTask,
              childTools(readTools(port, childId, child.definition.tools)),
              Proposal,
            );
            if (!r.ok) return { ok: false, stop: r.stop };
            const proposal = r.output as Proposal;
            await dispatch(childId, proposal, r.reads);
            return { ok: true, proposal };
          },
        }),
      );
  }

  const result = await run(rootRunId, root, task, tools, ProposalList);
  if (result.ok)
    for (const p of (result.output as z.infer<typeof ProposalList>).proposals)
      await dispatch(rootRunId, p, result.reads);
  return {
    rootRunId,
    status: tree.halted
      ? 'stopped'
      : result.ok
        ? 'done'
        : result.stop === 'escalate'
          ? 'escalated'
          : 'stopped',
    ...(tree.halted ? { stop: 'halted' } : result.ok ? {} : { stop: result.stop }),
    outcomes,
    digest,
  };
}
