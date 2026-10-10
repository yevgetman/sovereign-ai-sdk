import { listRoutes } from '../routes/catalog.js';
import { RouteError } from '../routes/errors.js';
import type { ProviderRequest } from '../types.js';
import type { ModelRecord } from './types.js';

/** Verified serializer support, separate from a publisher's model claims.
 * Subscription transports remain fenced even if their API siblings support vision.
 * False means no built-in verified serializer, not a rejection of a custom adapter. */
export function serializerSupportsImages(provider: string): boolean {
  return ['anthropic', 'openai', 'openrouter', 'xai', 'ollama', 'sov', 'manifest'].includes(
    provider,
  );
}

/** Validate the complete request, including replayed multimodal/tool history.
 * Metadata is optional for compatibility with injected/custom providers. When
 * supplied, unknown capability never becomes an affirmative support claim.
 * Bundled non-authoritative suggestions preserve existing serializer behavior;
 * they do not add evidence or certify per-model support. */
export function validateModelRequest(
  req: ProviderRequest,
  provider: string,
  metadata?: ModelRecord,
): void {
  const images = req.messages.some((message) =>
    message.content.some((block) => block.type === 'image'),
  );
  const tools = Boolean(
    req.tools?.length ||
      req.toolChoice ||
      req.messages.some((message) =>
        message.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result'),
      ),
  );
  if (metadata && (metadata.id !== req.model || metadata.provider !== provider)) {
    throw new RouteError(
      'model_unsupported',
      'Model metadata does not match the selected model and provider.',
    );
  }
  if (metadata?.capabilities.textOutput === 'unsupported') {
    throw new RouteError('unsupported_input', 'The selected model does not support text output.');
  }
  if (
    images &&
    ['openai', 'openrouter', 'xai', 'ollama', 'sov', 'manifest'].includes(provider) &&
    req.messages.some(
      (message) =>
        message.role === 'assistant' && message.content.some((block) => block.type === 'image'),
    )
  ) {
    throw new RouteError(
      'unsupported_input',
      'Image input must use a user message for this transport.',
    );
  }
  if (images && ['chatgpt', 'grok', 'claude-max'].includes(provider)) {
    throw new RouteError(
      'unsupported_input',
      'The selected transport has no verified image serializer.',
    );
  }
  const legacySuggestions = metadata?.metadata.source === 'bundled-suggestions';
  const directApi =
    metadata?.auth === 'api_key' && ['anthropic', 'openai', 'xai'].includes(provider);
  const establishedNativeImage =
    directApi &&
    listRoutes().some(
      (route) =>
        route.id === metadata?.routeId &&
        route.provider === provider &&
        route.models.includes(req.model),
    );
  const customSerializer =
    ['sov', 'manifest', 'ollama'].includes(provider) ||
    !['anthropic', 'openai', 'openrouter', 'xai', 'chatgpt', 'grok', 'claude-max'].includes(
      provider,
    );
  if (
    images &&
    metadata &&
    (metadata.capabilities.images === 'unsupported' ||
      (!legacySuggestions &&
        !establishedNativeImage &&
        !customSerializer &&
        metadata.capabilities.images !== 'supported'))
  ) {
    throw new RouteError(
      'unsupported_input',
      metadata.capabilities.images === 'unknown'
        ? 'Image support for the selected model is unknown.'
        : 'The selected model does not support image input.',
    );
  }
  if (
    tools &&
    metadata &&
    (metadata.capabilities.tools === 'unsupported' ||
      (!legacySuggestions &&
        !directApi &&
        !customSerializer &&
        metadata.capabilities.tools !== 'supported'))
  ) {
    throw new RouteError(
      'unsupported_input',
      metadata.capabilities.tools === 'unknown'
        ? 'Tool support for the selected model is unknown.'
        : 'The selected model does not support tools.',
    );
  }
  if (
    req.toolChoice &&
    metadata?.toolChoices &&
    !metadata.toolChoices.includes(req.toolChoice.type)
  ) {
    throw new RouteError(
      'unsupported_input',
      'The selected model does not support this tool-choice format.',
    );
  }
}
