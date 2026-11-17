/** The call did not answer in time. */
export class ChatTimeoutError extends Error {
  constructor() {
    super('model call timed out');
    this.name = 'ChatTimeoutError';
  }
}

/** Runs `work` with an abort signal and rejects with `ChatTimeoutError` after `ms`. */
export async function withTimeout<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first: aborting can make the work reject synchronously and win the race.
      reject(new ChatTimeoutError());
      ac.abort();
    }, ms);
  });
  try {
    return await Promise.race([work(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
