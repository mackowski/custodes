/**
 * Agent tracing (ADR 0016): OpenTelemetry GenAI spans over the Workers custom spans API, so the
 * Cloudflare Agents dashboard shows each turn, its model calls and its tool runs.
 *
 * - A turn is one evaluated issue or pull request; its conversation id is `<owner>/<repo>#<n>`.
 * - Payloads (prompts, messages, tool arguments) are recorded only when the turn allows it.
 * - Errors carry `error.type` only (class, status, provider code), never a message: provider
 *   errors quote response bodies.
 * - Code outside a turn gets no spans.
 *
 * Pure: the runtime `tracing` from `cloudflare:workers` is passed in by `CustodesAgent`.
 */

export type AttributeValue = string | number | boolean;

/** The part of the Workers `Span` used here. */
export interface TraceSpan {
  setAttribute(key: string, value: AttributeValue): unknown;
  setStatus(status: { code: 'unset' | 'ok' | 'error' }): unknown;
}

/** The part of the Workers `tracing` API used here; tests pass a recording fake. */
export interface Tracer {
  enterSpan<T>(name: string, callback: (span: TraceSpan) => T): T;
}

export interface AgentIdentity {
  /** Logical agent: the manifest id (`triage`, `pr-gate`). */
  agentName: string;
  /** Stable instance: `<manifest id>/<Durable Object name>`. */
  agentId: string;
  /** The issue or pull request the turn is about: `<owner>/<repo>#<number>`. */
  conversationId: string;
  runId: string;
}

/** One agent turn: who it is, where spans go, and whether payloads may be recorded. */
export interface Turn {
  identity: AgentIdentity;
  tracer: Tracer;
  /** `TRACE_PAYLOADS === "true"`. Credentials and error text are never recorded either way. */
  payloads: boolean;
}

/** Handle given to traced code. */
export interface OperationSpan {
  /** A metadata attribute; `undefined` is skipped. */
  set(key: string, value: AttributeValue | undefined): void;
  /** A payload attribute, recorded only when the turn allows payloads. Non-strings become JSON. */
  payload(key: string, value: unknown): void;
}

export function conversationOf(repo: string, number: number): string {
  return `${repo}#${number}`;
}

const SAFE_PART = /^[A-Za-z0-9_.-]{1,60}$/;

/** Low-cardinality error id: class, HTTP status and provider error type or reason; no message. */
export function errorType(err: unknown): string {
  if (!(err instanceof Error)) return 'error';
  const e = err as Error & { status?: unknown; errorType?: unknown; reason?: unknown };
  const parts = [err.name];
  if (typeof e.status === 'number') parts.push(String(e.status));
  if (typeof e.errorType === 'string') parts.push(e.errorType);
  if (typeof e.reason === 'string') parts.push(e.reason);
  const safe = parts.filter((p) => SAFE_PART.test(p));
  return safe.length ? safe.join(' ') : 'error';
}

function identityAttributes(id: AgentIdentity): Record<string, AttributeValue> {
  return {
    'gen_ai.agent.name': id.agentName,
    'gen_ai.agent.id': id.agentId,
    'gen_ai.conversation.id': id.conversationId,
    'custodes.run_id': id.runId,
  };
}

const NO_OP: OperationSpan = { set: () => undefined, payload: () => undefined };

const NO_SPAN: TraceSpan = { setAttribute: () => undefined, setStatus: () => undefined };

/** A tracer that records nothing: the fallback when the runtime has no `tracing`. */
export const NO_TRACER: Tracer = { enterSpan: (_name, callback) => callback(NO_SPAN) };

type Outcome<T> = { ok: true; value: T } | { ok: false; err: unknown };

/**
 * Tracing must never change what an agent does:
 * - a span method that throws (or is missing in an older runtime) is ignored;
 * - if `enterSpan` itself throws before running the callback, `fn` runs untraced;
 * - an error never crosses `enterSpan`, so the runtime cannot record its message on the span
 *   (provider errors quote response bodies). It is rethrown after the span has ended.
 */
async function traced<T>(
  turn: Turn,
  name: string,
  attributes: Record<string, AttributeValue>,
  fn: (span: OperationSpan) => Promise<T>,
): Promise<T> {
  // Set inside the callback; widened so the checker does not narrow it to `false`.
  let started = false as boolean;
  let outcome: Outcome<T>;
  try {
    outcome = await turn.tracer.enterSpan(name, async (span): Promise<Outcome<T>> => {
      started = true;
      const guarded = (op: () => unknown) => {
        try {
          op();
        } catch {
          /* ignored */
        }
      };
      for (const [k, v] of Object.entries(attributes)) guarded(() => span.setAttribute(k, v));
      const handle: OperationSpan = {
        set: (k, v) => {
          if (v !== undefined) guarded(() => span.setAttribute(k, v));
        },
        payload: (k, v) => {
          if (turn.payloads)
            guarded(() => span.setAttribute(k, typeof v === 'string' ? v : JSON.stringify(v)));
        },
      };
      try {
        return { ok: true, value: await fn(handle) };
      } catch (err) {
        guarded(() => span.setAttribute('error.type', errorType(err)));
        guarded(() => span.setStatus({ code: 'error' }));
        return { ok: false, err };
      }
    });
  } catch (err) {
    // The callback never throws, so this is the tracer failing. Before the callback ran, nothing
    // has happened yet and `fn` runs untraced; after it, running `fn` again could repeat a side
    // effect, so the failure surfaces.
    if (started) throw err;
    return fn(NO_OP);
  }
  if (!outcome.ok) throw outcome.err;
  return outcome.value;
}

/** The `invoke_agent` span around one turn. Without a turn, `fn` runs untraced. */
export function invokeAgent<T>(
  turn: Turn | undefined,
  fn: (span: OperationSpan) => Promise<T>,
): Promise<T> {
  if (!turn) return fn(NO_OP);
  return traced(
    turn,
    `invoke_agent ${turn.identity.agentName}`,
    { 'gen_ai.operation.name': 'invoke_agent', ...identityAttributes(turn.identity) },
    fn,
  );
}

/** A `chat` span around one model call. Without a turn, `fn` runs untraced. */
export function chat<T>(
  turn: Turn | undefined,
  call: { provider: string; model: string },
  fn: (span: OperationSpan) => Promise<T>,
): Promise<T> {
  if (!turn) return fn(NO_OP);
  return traced(
    turn,
    `chat ${call.model}`,
    {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': call.provider,
      'gen_ai.request.model': call.model,
      ...identityAttributes(turn.identity),
    },
    fn,
  );
}

/** An `execute_tool` span around one tool run (a broker action or read). Without a turn, untraced. */
export function executeTool<T>(
  turn: Turn | undefined,
  tool: string,
  fn: (span: OperationSpan) => Promise<T>,
): Promise<T> {
  if (!turn) return fn(NO_OP);
  return traced(
    turn,
    `execute_tool ${tool}`,
    { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': tool },
    fn,
  );
}
