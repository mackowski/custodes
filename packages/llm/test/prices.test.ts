import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAgentMd } from '@custodes/schema';
import { costOf, PRICES_USD_PER_MTOK } from '../src/prices.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Every agent.md in the repository, outside dependencies and build output. */
function agentFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.wrangler', 'coverage'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) agentFiles(p, out);
    else if (e.name === 'agent.md') out.push(p);
  }
  return out;
}

describe('costOf', () => {
  it('prices input and output tokens per million', () => {
    expect(costOf('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 })).toBe(
      3,
    );
  });
  it('refuses a model without a price instead of counting it as free', () => {
    expect(() => costOf('openai/gpt-6-luna', { input_tokens: 1, output_tokens: 1 })).toThrow(
      /no price/,
    );
    expect(() => costOf('constructor', { input_tokens: 1, output_tokens: 1 })).toThrow(/no price/);
  });
  it('refuses a usage without token counts: NaN would switch every budget cap off', () => {
    const missing = { input_tokens: undefined, output_tokens: 1 } as unknown as {
      input_tokens: number;
      output_tokens: number;
    };
    expect(() => costOf('claude-sonnet-5-5', missing)).toThrow(/not a token count/);
    expect(() => costOf('claude-sonnet-5-5', { input_tokens: -5, output_tokens: 0 })).toThrow(
      /not a token count/,
    );
  });
  it('has a positive price for every model in it', () => {
    for (const p of Object.values(PRICES_USD_PER_MTOK)) {
      expect(p.input).toBeGreaterThan(0);
      expect(p.output).toBeGreaterThan(p.input);
    }
  });
  it('has a price for the model of every agent.md in the repository', () => {
    const files = agentFiles(ROOT);
    // Not vacuous (security review of #166, L2): backlog-review and its item-review role.
    expect(files).toHaveLength(2);
    for (const f of files) {
      const { definition } = parseAgentMd(readFileSync(f, 'utf8'));
      expect(
        Object.hasOwn(PRICES_USD_PER_MTOK, definition.model),
        `${relative(ROOT, f)}: no price for ${definition.model}`,
      ).toBe(true);
    }
  });
});
