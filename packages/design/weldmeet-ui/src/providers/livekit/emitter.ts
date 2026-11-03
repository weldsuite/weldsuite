/**
 * The event surface RealtimeKit's objects have (`on`, `off`, their
 * `addListener`/`removeListener` aliases, `once`), which the WeldMeet UI
 * subscribes through. Handlers that throw are logged and never stop the
 * others.
 */

// The UI's handlers take whatever payload an event carries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (...args: any[]) => void;

export class Emitter {
  private readonly handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: string, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  addListener(event: string, handler: Handler): this {
    return this.on(event, handler);
  }

  removeListener(event: string, handler: Handler): this {
    return this.off(event, handler);
  }

  once(event: string, handler: Handler): this {
    const wrapped: Handler = (...args) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.handlers.clear();
    else this.handlers.delete(event);
    return this;
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[WeldMeet:LiveKit] a '${event}' handler failed:`, err);
      }
    }
  }
}
