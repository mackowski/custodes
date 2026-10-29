import { AsyncLocalStorage } from 'node:async_hooks';
import type { AttributeValue, Tracer, TraceSpan, Turn } from '@custodes/core';

export interface RecordedSpan {
  name: string;
  attributes: Record<string, AttributeValue>;
  status: 'unset' | 'ok' | 'error';
  parent: RecordedSpan | undefined;
  children: RecordedSpan[];
}

export interface FaultyOptions {
  /** Make setAttribute throw. */
  attribute?: boolean;
  /** Make setStatus throw. */
  status?: boolean;
}

/** A Tracer that records spans as a tree; nesting follows the awaited callbacks. */
export class RecordingTracer implements Tracer {
  readonly spans: RecordedSpan[] = [];
  readonly roots: RecordedSpan[] = [];
  private readonly current = new AsyncLocalStorage<RecordedSpan>();

  constructor(private readonly faulty: FaultyOptions = {}) {}

  enterSpan<T>(name: string, callback: (span: TraceSpan) => T): T {
    const parent = this.current.getStore();
    const rec: RecordedSpan = { name, attributes: {}, status: 'unset', parent, children: [] };
    this.spans.push(rec);
    (parent ? parent.children : this.roots).push(rec);
    const faulty = this.faulty;
    const span: TraceSpan = {
      setAttribute: (k, v) => {
        if (faulty.attribute) throw new Error('setAttribute boom');
        rec.attributes[k] = v;
      },
      setStatus: (s) => {
        if (faulty.status) throw new Error('setStatus boom');
        rec.status = s.code;
      },
    };
    // Nesting follows async context, as in the Workers runtime, so concurrent calls are siblings.
    return this.current.run(rec, () => callback(span));
  }

  named(prefix: string): RecordedSpan[] {
    return this.spans.filter((s) => s.name.startsWith(prefix));
  }

  /** Every attribute value of every span, as strings, for leak scans. */
  allValues(): string[] {
    return this.spans.flatMap((s) => Object.values(s.attributes).map(String));
  }
}

export const IDENTITY = {
  agentName: 'triage',
  agentId: 'triage/OWASP-CheatSheetSeries',
  conversationId: 'OWASP/CheatSheetSeries#7',
  runId: 'run-1',
};

export function turnOf(tracer: Tracer, payloads: boolean): Turn {
  return { identity: IDENTITY, tracer, payloads };
}
