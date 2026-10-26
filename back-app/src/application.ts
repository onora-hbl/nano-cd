import type { KubernetesObject } from '@kubernetes/client-node'
import type { Duration, PersistedMetadata, Timestamp } from './K8sInterface.js'

export const GROUP = 'nanocd.ozyria.fr'
export const VERSION = 'v1'
export const PLURAL = 'applications'

export type ApplicationSourceType = 'raw' | 'helm'

export interface ApplicationSpec {
  repo: string
  branch: string
  authSecretRef?: string
  source: {
    type: ApplicationSourceType
    path: string
  }
  sync: {
    interval: Duration
    paused: boolean
  }
  prune: boolean
}

export type ApplicationSyncStatus = 'Synced' | 'OutOfSync' | 'Syncing'

export interface K8sObjectRef {
  apiVersion: string
  kind: string
  namespace?: string
  name: string
}

export interface ApplicationStatusError {
  step: string
  message: string
  object?: K8sObjectRef
}

export interface ApplicationStatus {
  lastObservedGeneration?: number
  syncStatus?: ApplicationSyncStatus
  lastSyncedCommit?: string
  lastSyncStartTime?: Timestamp
  lastSyncEndTime?: Timestamp
  reason?: string
  message?: string
  errors?: ApplicationStatusError[]
  inventory: K8sObjectRef[]
}

export interface ApplicationCrd extends KubernetesObject {
  metadata: PersistedMetadata
  spec: ApplicationSpec
  status?: ApplicationStatus
}
