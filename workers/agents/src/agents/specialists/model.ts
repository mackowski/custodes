import { MODELS, type MessagesRequest } from '@custodes/llm';

/**
 * The single place the specialist model requests are shaped; the agents and the deploy-time smoke
 * test both use these builders.
 *
 * Choosing files is a short classification on the fast model with thinking disabled (Sonnet 5
 * rejects sampling parameters). The assessment runs on the reasoning model: Opus 5.5 always thinks
 * and rejects `thinking: {type: 'disabled'}`, so the field is omitted; `max_tokens` covers the
 * thinking and the answer.
 */
export function selectRequest(
  system: string,
  user: string,
  metadata: MessagesRequest['metadata'],
): MessagesRequest {
  return {
    model: MODELS.fast,
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens: 300,
    thinking: { type: 'disabled' },
    metadata,
  };
}

export function assessRequest(
  system: string,
  user: string,
  metadata: MessagesRequest['metadata'],
): MessagesRequest {
  return {
    model: MODELS.reasoning,
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens: 16_000,
    metadata,
  };
}
