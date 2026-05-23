// Channel adapter contract. Thin type-only module — concrete adapters
// (Telegram, Slack) are Phase 16.5+ deliverables.

export type Attachment = {
  type: 'image' | 'file' | 'audio' | 'video';
  url: string;
  name?: string;
  mimeType?: string;
};

export type InboundMessage = {
  sender: string;
  channel: string;
  chatId: string;
  chatType: 'private' | 'channel' | 'group';
  threadId?: string;
  text: string;
  attachments?: Attachment[];
  raw?: unknown;
};

export type DeliveryResult = {
  ok: boolean;
  error?: string;
  silent?: boolean;
};

export type SecretTarget = {
  key: string;
  type: 'env' | 'inline' | 'secret-uri';
  required: boolean;
  included: 'always' | 'if-configured';
};

/** Minimal ChannelAdapter shell. Full optional-method contract
 *  (outbound, monitor, setup, auth, etc.) deferred to Phase 16.5+. */
export type ChannelAdapter = {
  id: string;
  secretTargets?: SecretTarget[];
};
