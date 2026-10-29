/**
 * Runs one role (a reviewer, the scope classifier or the judge) as a sub-agent of the turn
 * (ADR 0016 amendment): `invoke_agent <role>` with its model calls under it. The primary model
 * gets one retry on HTTP 429 and one chance to repair an answer that does not parse; any other
 * failure moves to the role's fallback, which is reported, never silent (ADR 0017).
 */
import type { z } from 'zod';
import { errorType, invokeSubAgent, type Turn } from '@custodes/core';
import { AgentHaltedError } from '@custodes/core/agent';
import {
  GatewayError,
  parseStructured,
  StructuredOutputError,
  type ChatModel,
  type ReviewModel,
  type ReviewModelName,
} from '@custodes/llm';
import { LINEUP, model, type Role, type RoleOutcome } from './lineup.js';

export interface RunnerDeps {
  clients: Record<ReviewModel['transport'], ChatModel>;
  /** Kill switch: called before every model call. */
  guard: () => Promise<void>;
  /** Limits concurrent model calls (AI Gateway's rate limit is shared by every agent). */
  limit: <T>(work: () => Promise<T>) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  agentId: string;
  runId: string;
  turn: Turn | undefined;
}

export interface RoleResult<T> {
  outcome: RoleOutcome;
  answer?: T;
}

const REPAIR = `Your previous answer could not be parsed as the JSON object described above. Answer again with that JSON object only, nothing else.`;

/** A tiny semaphore. */
export function limiter(max: number): RunnerDeps['limit'] {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

async function ask<S extends z.ZodType>(
  deps: RunnerDeps,
  role: Role,
  name: ReviewModelName,
  schema: S,
  system: string,
  user: string,
  sub: Turn | undefined,
): Promise<z.infer<S>> {
  const m = model(name);
  const call = async (prompt: string) => {
    await deps.guard();
    return deps.limit(() =>
      deps.clients[m.transport].complete(
        {
          model: m.id,
          system,
          user: prompt,
          max_tokens: LINEUP[role].max_tokens,
          metadata: { agentId: deps.agentId, runId: deps.runId, subAgent: role },
        },
        sub,
      ),
    );
  };
  let res;
  try {
    res = await call(user);
  } catch (err) {
    if (!(err instanceof GatewayError) || err.status !== 429) throw err;
    await deps.sleep(2_000);
    res = await call(user);
  }
  try {
    return parseStructured(schema, res.text);
  } catch (err) {
    if (!(err instanceof StructuredOutputError)) throw err;
    const again = await call(`${user}\n\n${REPAIR}`);
    return parseStructured(schema, again.text);
  }
}

export async function runRole<S extends z.ZodType>(
  deps: RunnerDeps,
  role: Role,
  schema: S,
  system: string,
  user: string,
): Promise<RoleResult<z.infer<S>>> {
  return invokeSubAgent(deps.turn, role, async (sub, span) => {
    const { primary, fallback } = LINEUP[role];
    try {
      const answer = await ask(deps, role, primary, schema, system, user, sub);
      span.set('custodes.review.model', primary);
      return { outcome: { role, status: 'ran', model: primary }, answer };
    } catch (first) {
      if (first instanceof AgentHaltedError) throw first;
      const why = errorType(first);
      span.set('custodes.review.failed_model', primary);
      span.set('custodes.review.failed_why', why);
      try {
        const answer = await ask(deps, role, fallback, schema, system, user, sub);
        span.set('custodes.review.model', fallback);
        return {
          outcome: { role, status: 'fallback', model: fallback, failed: primary, why },
          answer,
        };
      } catch (second) {
        if (second instanceof AgentHaltedError) throw second;
        const both = `${why}; ${errorType(second)}`;
        span.set('custodes.review.unavailable', both);
        return { outcome: { role, status: 'unavailable', tried: [primary, fallback], why: both } };
      }
    }
  });
}
