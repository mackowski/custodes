import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'] },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          kvNamespaces: ['KILL_SWITCH'],
          d1Databases: ['AUDIT'],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
  };
});
