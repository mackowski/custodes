import { MODELS, type MessagesRequest } from '@custodes/llm';

/**
 * The single place the triage model request is shaped. The agent and the deploy-time smoke test
 * both use it, so a parameter the model rejects fails the pipeline instead of every production call.
 *
 * - No sampling parameters (Sonnet 5 rejects `temperature`, `top_p`, `top_k`).
 * - Thinking is disabled: this is a short classification and adaptive thinking would spend the
 *   small output budget before any JSON is written.
 */
export function triageRequest(
  system: string,
  user: string,
  metadata: MessagesRequest['metadata'],
): MessagesRequest {
  return {
    model: MODELS.fast,
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens: 700,
    thinking: { type: 'disabled' },
    metadata,
  };
}
