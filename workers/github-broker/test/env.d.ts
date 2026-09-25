// Test-only binding injected by vitest.config.ts; merges into the generated Cloudflare.Env.
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
