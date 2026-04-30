import { describe, expect, it } from 'vitest';
import {
  createDiscoveryRequestDedupeStore,
  shouldProcessDiscoveryRequest,
} from './alwaysOnDiscoveryRequestDedupe';

describe('shouldProcessDiscoveryRequest', () => {
  it('processes a request id only once', () => {
    const store = createDiscoveryRequestDedupeStore();

    expect(shouldProcessDiscoveryRequest(store, 'request-1')).toBe(true);
    expect(shouldProcessDiscoveryRequest(store, 'request-1')).toBe(false);
    expect(shouldProcessDiscoveryRequest(store, ' request-1 ')).toBe(false);
  });

  it('rejects missing or blank request ids', () => {
    const store = createDiscoveryRequestDedupeStore();

    expect(shouldProcessDiscoveryRequest(store, undefined)).toBe(false);
    expect(shouldProcessDiscoveryRequest(store, '')).toBe(false);
    expect(shouldProcessDiscoveryRequest(store, '   ')).toBe(false);
  });

  it('evicts oldest request ids when the store exceeds max size', () => {
    const store = createDiscoveryRequestDedupeStore();

    expect(shouldProcessDiscoveryRequest(store, 'request-1', 2)).toBe(true);
    expect(shouldProcessDiscoveryRequest(store, 'request-2', 2)).toBe(true);
    expect(shouldProcessDiscoveryRequest(store, 'request-3', 2)).toBe(true);

    expect(shouldProcessDiscoveryRequest(store, 'request-1', 2)).toBe(true);
    expect(shouldProcessDiscoveryRequest(store, 'request-2', 2)).toBe(true);
    expect(shouldProcessDiscoveryRequest(store, 'request-3', 2)).toBe(true);
  });
});
