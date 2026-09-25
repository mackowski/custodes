const enc = new TextEncoder();

/**
 * Verifies `X-Hub-Signature-256` for a GitHub webhook. Uses WebCrypto's HMAC verify, which is
 * constant-time, instead of comparing hex strings.
 */
export async function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const hex = signatureHeader.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(hex)) return false;
  const sig = Uint8Array.from(hex.match(/.{2}/g) ?? [], (h) => parseInt(h, 16));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(rawBody));
}
