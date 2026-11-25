/**
 * The agent loop (ADR 0023): one model, read tools only, bounded. The runtime, not the agent
 * author, wraps every tool result in `untrusted()` and parses the final answer with
 * `parseStructured()`. It lives in `@custodes/llm` because both helpers do; the dispatcher that
 * routes the result to a side effect is in `@custodes/core`.
 */
import { canonicalJson, sha256Hex } from '@custodes/core';
import type { ProgressState, TargetRead, ToolCallRecord } from '@custodes/schema';
import { z } from 'zod';
import {
  AnthropicGateway,
  ModelOutputError,
  type ContentBlockParam,
  type MessageParam,
  type MessagesRequest,
  type MessagesResponse,
} from './gateway.js';
import { parseStructured, StructuredOutputError } from './structured.js';
import { UNTRUSTED_DATA_RULES, untrusted } from './untrusted.js';

/** A read tool. `run` gets validated arguments; `read` names the target it read, if any. */
export interface RuntimeTool {
  name: string;
  description: string;
  args: z.ZodType;
  run(args: unknown): Promise<{ content: string; read?: TargetRead }>;
}

/** Typed helper: `run` sees the parsed arguments of its own schema. */
export function defineTool<A extends z.ZodType>(t: {
  name: string;
  description: string;
  args: A;
  run(args: z.infer<A>): Promise<{ content: string; read?: TargetRead }>;
}): RuntimeTool {
  return t;
}

export type StopReason =
  'rounds' | 'budget' | 'repeat' | 'undeclared_tool' | 'invalid_args' | 'halted' | 'invalid_output';

export interface LoopInput<S extends z.ZodType> {
  model: string;
  system: string;
  /** The trusted task (from code or the operator), never text read from GitHub. */
  task: string;
  tools: readonly RuntimeTool[];
  output: S;
  caps: { rounds: number; usd: number };
  maxTokens: number;
  metadata: { agentId: string; runId: string };
  /** Set on a restart: what earlier runs did, as code recorded it. */
  progress?: ProgressState;
}

export interface LoopDeps {
  send(req: MessagesRequest): Promise<MessagesResponse>;
  /** Throws when the agent, the fleet or this run is halted (`CustodesAgent.guard()`). */
  guard(): Promise<void>;
  /** USD for one response's usage. */
  costOf(usage: MessagesResponse['usage']): number;
}

interface RunState {
  progress: ProgressState;
  reads: TargetRead[];
  usd: number;
  rounds: number;
}
export type LoopResult<T> =
  ({ ok: true; output: T } & RunState) | ({ ok: false; stop: StopReason } & RunState);

/** The same tool with the same arguments this many times stops the run (loop detection). */
export const MAX_IDENTICAL_CALLS = 3;
/** Restarts after a round cap before the run is escalated to the operator (ADR 0023). */
export const MAX_RESTARTS = 2;

/** One run: rounds of model call → tool calls → results, until an answer or a stop. */
export async function runLoop<S extends z.ZodType>(
  input: LoopInput<S>,
  deps: LoopDeps,
  spentUsd = 0,
): Promise<LoopResult<z.infer<S>>> {
  const progress: ProgressState = input.progress ?? { calls: [], itemsDone: [], restarts: 0 };
  const state: RunState = {
    progress: { ...progress, calls: [...progress.calls] },
    reads: [],
    usd: spentUsd,
    rounds: 0,
  };
  const stop = (reason: StopReason): LoopResult<z.infer<S>> => ({
    ok: false,
    stop: reason,
    ...state,
  });
  const byName = new Map(input.tools.map((t) => [t.name, t]));
  const tools = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.args),
  }));
  const messages: MessageParam[] = [{ role: 'user', content: firstMessage(input) }];

  for (;;) {
    if (state.rounds >= input.caps.rounds) return stop('rounds');
    if (state.usd >= input.caps.usd) return stop('budget');
    try {
      await deps.guard();
    } catch {
      return stop('halted');
    }
    state.rounds++;
    let res: MessagesResponse;
    try {
      res = await deps.send({
        model: input.model,
        system: `${input.system}\n\n${UNTRUSTED_DATA_RULES}`,
        messages,
        max_tokens: input.maxTokens,
        tools,
        metadata: input.metadata,
      });
    } catch (err) {
      if (err instanceof ModelOutputError) return stop('invalid_output');
      throw err;
    }
    state.usd += deps.costOf(res.usage);

    const calls = AnthropicGateway.toolUses(res);
    if (calls.length === 0) {
      try {
        return {
          ok: true,
          output: parseStructured(input.output, AnthropicGateway.text(res)),
          ...state,
        };
      } catch (err) {
        if (err instanceof StructuredOutputError) return stop('invalid_output');
        throw err;
      }
    }
    if (state.usd >= input.caps.usd) return stop('budget');

    // Check every call before running any: a response is all-or-nothing.
    const checked: { id: string; tool: RuntimeTool; args: unknown; argsHash: string }[] = [];
    for (const call of calls) {
      const tool = byName.get(call.name);
      if (!tool) return stop('undeclared_tool');
      const parsed = tool.args.safeParse(call.input);
      if (!parsed.success) return stop('invalid_args');
      const argsHash = await sha256Hex(canonicalJson({ tool: call.name, args: parsed.data }));
      const seen =
        state.progress.calls.filter((c) => c.name === call.name && c.argsHash === argsHash).length +
        checked.filter((c) => c.tool.name === call.name && c.argsHash === argsHash).length;
      if (seen + 1 >= MAX_IDENTICAL_CALLS) return stop('repeat');
      checked.push({ id: call.id, tool, args: parsed.data, argsHash });
    }

    const results: ContentBlockParam[] = [];
    for (const c of checked) {
      const out = await c.tool.run(c.args);
      if (out.read) state.reads.push(out.read);
      const record: ToolCallRecord = {
        name: c.tool.name,
        argsHash: c.argsHash,
        resultHash: await sha256Hex(out.content),
      };
      state.progress.calls.push(record);
      results.push({
        type: 'tool_result',
        tool_use_id: c.id,
        content: untrusted(`tool:${c.tool.name}`, out.content),
      });
    }
    messages.push({ role: 'assistant', content: res.content as ContentBlockParam[] });
    messages.push({ role: 'user', content: results });
  }
}

/**
 * Runs, and after a round cap starts a fresh run from the trusted task plus the code-computed
 * progress, at most MAX_RESTARTS times; then `escalate`. Spend carries over between runs.
 */
export async function runWithRestarts<S extends z.ZodType>(
  input: LoopInput<S>,
  deps: LoopDeps,
): Promise<LoopResult<z.infer<S>> | ({ ok: false; stop: 'escalate' } & RunState)> {
  let result = await runLoop(input, deps);
  while (!result.ok && result.stop === 'rounds') {
    if (result.progress.restarts >= MAX_RESTARTS) return { ...result, stop: 'escalate' };
    const progress = { ...result.progress, restarts: result.progress.restarts + 1 };
    result = await runLoop({ ...input, progress }, deps, result.usd);
  }
  return result;
}

/** The task, plus on a restart a note built only from ids and counts. */
function firstMessage(input: LoopInput<z.ZodType>): string {
  const p = input.progress;
  if (!p || p.restarts === 0) return input.task;
  const done = p.itemsDone.map((t) => `${t.repo}#${String(t.number)} (${t.kind})`).join(', ');
  return [
    input.task,
    '',
    `This is restart ${String(p.restarts)} of ${String(MAX_RESTARTS)} after the round cap.`,
    `Items already done: ${done || 'none'}.`,
    `Tool calls already made in earlier runs: ${String(p.calls.length)}. Repeating one counts towards the loop limit.`,
  ].join('\n');
}
