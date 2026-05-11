// Deterministic session key. Used as DB primary key, LRU cache key,
// and delivery target key. Invariant #8 from harness design principles.

import type { InboundMessage } from './types.js';

export function buildSessionKey(msg: InboundMessage): string {
  const parts = ['agent', 'main', msg.channel, msg.chatType, msg.chatId];
  if (msg.threadId !== undefined) parts.push(msg.threadId);
  return parts.join(':');
}
