import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface CorrelationStore {
  correlationId: string;
}

const store = new AsyncLocalStorage<CorrelationStore>();

/** Return the correlation ID for the current request, or `undefined` if none is set. */
export function getCorrelationId(): string | undefined {
  return store.getStore()?.correlationId;
}

/** Run `fn` inside a new correlation ID context (UUID v4). */
export function withCorrelationId<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return store.run({ correlationId: randomUUID() }, fn);
}
