import { DatabaseSync } from 'node:sqlite';
import type { SqlLike } from '../../src/runtime/run-store.js';

/** An in-memory SQLite with the shape of a Durable Object's `ctx.storage.sql` (eager, like it). */
export function memorySql(): SqlLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: (string | number | null)[]
    ) {
      const st = db.prepare(query);
      const rows =
        st.columns().length > 0 ? (st.all(...bindings) as T[]) : (st.run(...bindings), []);
      return { toArray: () => rows };
    },
  };
}
