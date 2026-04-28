import { mkdir, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import {
  getCronDaemonDiscoveryRequestDir,
  getCronDaemonDiscoveryRequestPath,
} from './paths.js'
import { jsonStringify } from '../utils/slowOperations.js'
import type { DiscoveryFireRequest } from './discoveryScheduler/types.js'

export async function enqueueDiscoveryFireRequest(
  request: DiscoveryFireRequest,
): Promise<string> {
  const fileId = `${Date.now()}-${randomUUID()}`
  await mkdir(getCronDaemonDiscoveryRequestDir(), { recursive: true })
  await writeFile(
    getCronDaemonDiscoveryRequestPath(fileId),
    jsonStringify({ ...request, fileId }, null, 2) + '\n',
    'utf-8',
  )
  return fileId
}
