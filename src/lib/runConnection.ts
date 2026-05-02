import { LOCAL_CONNECTION_ID } from '@/constants/connections'
import type { RunState } from '@/types/pipeline'
import type { ConnectionConfig, ConnectionState } from '@/types/ssh'

interface ConnectionEntryLike {
  config: ConnectionConfig
  status: ConnectionState
  isLocal?: boolean
}

type ConnectionMapLike = Record<string, ConnectionEntryLike | undefined>

export function resolveRunConnectionId(
  run: RunState,
  activeConnectionId: string | null,
  connections: ConnectionMapLike,
): string | null {
  if (run.connectionId === LOCAL_CONNECTION_ID) return LOCAL_CONNECTION_ID

  if (isUsableSshConnection(run.connectionId, connections)) return run.connectionId

  const preferredName = run.workspace?.connectionName?.trim().toLowerCase()
  if (
    activeConnectionId &&
    isUsableSshConnection(activeConnectionId, connections) &&
    connectionMatchesRun(connections[activeConnectionId], preferredName)
  ) {
    return activeConnectionId
  }

  for (const [id, entry] of Object.entries(connections)) {
    if (!isUsableSshConnection(id, connections)) continue
    if (connectionMatchesRun(entry, preferredName)) return id
  }

  if (activeConnectionId && isUsableSshConnection(activeConnectionId, connections)) {
    return activeConnectionId
  }

  return null
}

export function runConnectionUnavailableMessage(run: RunState): string {
  const name = run.workspace?.connectionName || 'the cluster'
  return `Reconnect to ${name} before opening files from this saved run.`
}

function isUsableSshConnection(id: string, connections: ConnectionMapLike): boolean {
  const entry = connections[id]
  return Boolean(entry && !entry.isLocal && entry.status === 'connected')
}

function connectionMatchesRun(entry: ConnectionEntryLike | undefined, preferredName: string | undefined): boolean {
  if (!entry || !preferredName) return true
  const config = entry.config
  return config.name.trim().toLowerCase() === preferredName ||
    config.host.trim().toLowerCase() === preferredName ||
    `${config.username}@${config.host}`.trim().toLowerCase() === preferredName
}
