export interface TrailerInput {
  agentId: string;
  agentVersion: string;
  attestationId: string;
  /** Base URL of the public verify endpoint, e.g. https://custodes.work/verify */
  verifyUrl?: string;
  /**
   * `hidden`: only the HTML comment, no visible footer (policy `trailer`, ADR 0019). The
   * attestation stays machine-readable for /verify.
   */
  visibility?: 'visible' | 'hidden';
}

/**
 * Every comment an agent posts carries a machine-readable HTML comment, and a visible footer unless
 * the policy sets `trailer: hidden`, so that anyone can tell which agent acted and can
 * verify the attestation.
 */
export function buildTrailers(input: TrailerInput): string {
  const lines = [
    `Custodes-Agent: ${input.agentId}@${input.agentVersion}`,
    `Custodes-Attestation: ${input.attestationId}`,
  ];
  const hidden = `\n<!--\n${lines.join('\n')}\n-->`;
  if (input.visibility === 'hidden') return `\n${hidden}`;
  const visible = lines.join(' · ');
  const link = input.verifyUrl ? ` · [verify](${input.verifyUrl}/${input.attestationId})` : '';
  return `\n\n---\n<sub>🛡️ ${visible}${link}</sub>${hidden}`;
}

export function appendTrailers(body: string, input: TrailerInput): string {
  return body.trimEnd() + buildTrailers(input);
}
