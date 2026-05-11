// Typed event bus. Wraps Node's EventEmitter with a type-safe API that
// narrows the event payload to the specific DaemonEvent variant by key.

import { EventEmitter } from 'node:events';
import type { DaemonEvent, DaemonEventMap, DaemonEventType } from './types.js';

export class DaemonEventBus {
  private readonly emitter = new EventEmitter();

  on<T extends DaemonEventType>(type: T, handler: (event: DaemonEventMap[T]) => void): this {
    this.emitter.on(type, handler);
    return this;
  }

  off<T extends DaemonEventType>(type: T, handler: (event: DaemonEventMap[T]) => void): this {
    this.emitter.off(type, handler);
    return this;
  }

  emit(event: DaemonEvent): void {
    this.emitter.emit(event.type, event);
  }
}
