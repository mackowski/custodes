import { describe, expect, it } from 'vitest';
import { packageOf, packagesOf } from '../../../scripts/bundle-manifest.js';

describe('bundle manifest (#105)', () => {
  it('reads name@version from pnpm store paths, scoped and with peer suffixes', () => {
    expect(
      packageOf(
        '../../node_modules/.pnpm/agents@0.33.0_@babel+core@8.0.6_@modelcontextprotocol+client@2.4_ab4/node_modules/agents/dist/x.js',
      ),
    ).toBe('agents@0.33.0');
    expect(
      packageOf(
        '../../node_modules/.pnpm/@modelcontextprotocol+client@2.4.0_zod@4.6.7/node_modules/@modelcontextprotocol/client/dist/a.js',
      ),
    ).toBe('@modelcontextprotocol/client@2.4.0');
    expect(packageOf('../../packages/schema/src/agent.ts')).toBe(null);
  });

  it('lists third-party and workspace packages, sorted and each once', () => {
    expect(
      packagesOf([
        '../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/a.js',
        '../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/b.js',
        '../../node_modules/.pnpm/hono@4.13.16/node_modules/hono/dist/c.js',
        '../../packages/schema/src/agent.ts',
        '../../packages/core/src/index.ts',
        'node-built-in-modules:path',
      ]),
    ).toEqual({
      thirdParty: ['hono@4.13.16', 'zod@4.6.7'],
      workspace: ['@custodes/core', '@custodes/schema'],
    });
  });
});
