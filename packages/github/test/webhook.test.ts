import { describe, expect, it } from 'vitest';
import { verifyGitHubWebhookSignature } from '../src/webhook.js';

// Vector from GitHub's docs: secret "It's a Secret to Everybody", body "Hello, World!"
const secret = "It's a Secret to Everybody";
const body = 'Hello, World!';
const sig = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

describe('verifyGitHubWebhookSignature', () => {
  it('accepts the documented vector', async () => {
    expect(await verifyGitHubWebhookSignature(secret, body, sig)).toBe(true);
  });
  it('rejects tampering, wrong secret and missing header', async () => {
    expect(await verifyGitHubWebhookSignature(secret, body + '!', sig)).toBe(false);
    expect(await verifyGitHubWebhookSignature('nope', body, sig)).toBe(false);
    expect(await verifyGitHubWebhookSignature(secret, body, null)).toBe(false);
    expect(await verifyGitHubWebhookSignature(secret, body, 'sha1=abc')).toBe(false);
  });
});
