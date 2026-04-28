import { enqueueDiscoveryFireRequest } from '../discoveryRequests.js'
import type {
  DiscoveryFireRequest,
  DiscoveryLockHandle,
  FreshDiscoveryHeartbeat,
} from './types.js'

export async function notifyDiscoveryClient(args: {
  projectRoot: string
  target: FreshDiscoveryHeartbeat
  lockHandle: DiscoveryLockHandle
}): Promise<DiscoveryFireRequest> {
  const request: DiscoveryFireRequest = {
    type: 'discovery_fire_request',
    requestId: args.lockHandle.requestId,
    projectRoot: args.projectRoot,
    targetWriterKind: args.target.body.writerKind,
    targetWriterId: args.target.body.writerId,
    createdAt: new Date().toISOString(),
  }
  await enqueueDiscoveryFireRequest(request)
  return request
}
