/**
 * Decision ladder: deterministic code first, then Jev (cheap typed classifier), then an LLM,
 * then a human. Each rung either decides or passes the question up. A rung that throws (provider
 * down, unusable output) also passes it up, so an outage costs money or attention, never a wrong
 * decision. Only the caller decides which rungs may lead to side effects.
 *
 * The trace holds rung names, scores and error classes only; never bodies or model text.
 */
export type Rung = 'rule' | 'jev' | 'llm' | 'human';

export type TraceDetail = Record<string, number | string | boolean>;

export type StepResult<T> =
  { decided: true; value: T; detail?: TraceDetail } | { decided: false; detail?: TraceDetail };

export interface LadderStep<T> {
  rung: Exclude<Rung, 'human'>;
  run: () => StepResult<T> | Promise<StepResult<T>>;
}

export interface TraceEntry {
  rung: Rung;
  outcome: 'decided' | 'undecided' | 'error';
  detail?: TraceDetail;
  error?: string;
}

export type LadderOutcome<T> =
  | { decided: true; value: T; rung: Exclude<Rung, 'human'>; trace: TraceEntry[] }
  | { decided: false; rung: 'human'; trace: TraceEntry[] };

export const decided = <T>(value: T, detail?: TraceDetail): StepResult<T> =>
  detail === undefined ? { decided: true, value } : { decided: true, value, detail };

export const undecided = <T = never>(detail?: TraceDetail): StepResult<T> =>
  detail === undefined ? { decided: false } : { decided: false, detail };

/** Runs the steps in order and stops at the first that decides. Nobody deciding means a human must. */
export async function climb<T>(steps: LadderStep<T>[]): Promise<LadderOutcome<T>> {
  const trace: TraceEntry[] = [];
  for (const step of steps) {
    let result: StepResult<T>;
    try {
      result = await step.run();
    } catch (err) {
      trace.push({ rung: step.rung, outcome: 'error', error: errorClass(err) });
      continue;
    }
    const entry: TraceEntry = {
      rung: step.rung,
      outcome: result.decided ? 'decided' : 'undecided',
    };
    if (result.detail !== undefined) entry.detail = result.detail;
    trace.push(entry);
    if (result.decided) return { decided: true, value: result.value, rung: step.rung, trace };
  }
  trace.push({ rung: 'human', outcome: 'undecided' });
  return { decided: false, rung: 'human', trace };
}

export interface Band {
  /** At or above: yes. */
  yes: number;
  /** At or below: no. */
  no: number;
}

/** Maps a probability to yes / no / unsure using an explicit confidence band. */
export function verdict(p: number, band: Band): 'yes' | 'no' | 'unsure' {
  if (!(band.no < band.yes)) throw new RangeError('band.no must be below band.yes');
  if (Number.isNaN(p)) return 'unsure';
  if (p >= band.yes) return 'yes';
  if (p <= band.no) return 'no';
  return 'unsure';
}

/** Error name only (e.g. GatewayError), so traces never carry provider messages or content. */
function errorClass(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : 'Error';
}
