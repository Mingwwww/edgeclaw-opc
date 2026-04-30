export type DiscoveryRequestDedupeStore = {
  seen: Set<string>;
  order: string[];
};

export function createDiscoveryRequestDedupeStore(): DiscoveryRequestDedupeStore {
  return {
    seen: new Set<string>(),
    order: [],
  };
}

export function shouldProcessDiscoveryRequest(
  store: DiscoveryRequestDedupeStore,
  requestId: unknown,
  maxSize = 100,
): boolean {
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    return false;
  }

  const normalized = requestId.trim();
  if (store.seen.has(normalized)) {
    return false;
  }

  store.seen.add(normalized);
  store.order.push(normalized);

  while (store.order.length > maxSize) {
    const oldest = store.order.shift();
    if (oldest) {
      store.seen.delete(oldest);
    }
  }

  return true;
}
