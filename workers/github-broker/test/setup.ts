import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Runs once per test file: bring the in-memory D1 up to the current schema.
await applyD1Migrations(env.AUDIT, env.TEST_MIGRATIONS);
