import { ApiException, PatchStrategy, setHeaderOptions, type KubernetesObject } from '@kubernetes/client-node'
import {
  GROUP,
  PLURAL,
  VERSION,
  type ApplicationCrd,
  type ApplicationStatus,
  type ApplicationStatusError,
} from './application.js'
import { type GitManager } from './GitManager.js'
import type { K8sInterface } from './K8sInterface.js'
import logger from './utils/logger.js'
import { parseAllDocuments } from 'yaml'
import { isDeepStrictEqual } from 'node:util'

class SyncError extends Error {
  constructor(
    public override message: string,
    public reason: string,
    public errors: ApplicationStatusError[],
  ) {
    super(message)
  }
}

export class SyncManager implements Disposable {
  private childLogger
  private syncInProgress = new Set<string>()

  constructor(
    private k8sInterface: K8sInterface,
    private gitManager: GitManager,
  ) {
    this.childLogger = logger.child({ component: 'SyncManager' })
  }

  private async updateStatus(app: ApplicationCrd, status: Partial<ApplicationStatus>) {
    await this.k8sInterface.CustomObjectApi.patchNamespacedCustomObjectStatus(
      {
        group: GROUP,
        version: VERSION,
        plural: PLURAL,
        namespace: app.metadata.namespace,
        name: app.metadata.name,
        body: { status },
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    )
  }

  private async getK8sObjects(object: any) {
    const dryRunRes = await this.k8sInterface.ObjectApi.patch(
      object,
      undefined,
      'All',
      'nano-cd',
      true,
      PatchStrategy.ServerSideApply,
    )
    let actualRes = null
    try {
      actualRes = await this.k8sInterface.ObjectApi.read(object)
    } catch (err) {
      if (!(err instanceof ApiException && err.code === 404)) {
        throw err
      }
    }
    return { dryRunRes, actualRes }
  }

  private async applyObject(object: any) {
    return await this.k8sInterface.ObjectApi.patch(
      object,
      undefined,
      undefined,
      'nano-cd',
      true,
      PatchStrategy.ServerSideApply,
    )
  }

  private clean(object: KubernetesObject): unknown {
    const { status, ...rest } = object as KubernetesObject & { status?: unknown }
    const { managedFields, resourceVersion, generation, creationTimestamp, uid, ...metadata } = rest.metadata ?? {}
    return { ...rest, metadata }
  }

  private areK8sObjectsEquivalent(obj1: KubernetesObject, obj2: KubernetesObject) {
    return isDeepStrictEqual(this.clean(obj1), this.clean(obj2))
  }

  private applyPriority(object: KubernetesObject): number {
    if (object.kind === 'Namespace') return 0
    if (object.kind === 'CustomResourceDefinition') return 1
    return 2
  }

  private async doSync(app: ApplicationCrd, manifests: string[]) {
    this.childLogger.info(`Syncing application: ${app.metadata.name} with ${manifests.length} manifests`)
    const objects = []
    for (const manifest of manifests) {
      for (const document of parseAllDocuments(manifest)) {
        if (document.errors.length > 0) throw new Error(JSON.stringify(document.errors))

        const value = document.toJS()
        if (value == null) continue

        const items = value.kind === 'List' ? value.items : [value]
        for (const item of items) {
          objects.push(item)
        }
      }
    }
    objects.sort((a, b) => this.applyPriority(a) - this.applyPriority(b))
    for (const obj of objects) {
      const k8sObjects = await this.getK8sObjects(obj)
      if (
        k8sObjects.actualRes !== null &&
        this.areK8sObjectsEquivalent(k8sObjects.dryRunRes as KubernetesObject, k8sObjects.actualRes as KubernetesObject)
      ) {
        this.childLogger.info(`Skipping object ${obj.kind}/${obj.metadata.name} in namespace ${obj.metadata.namespace}`)
        continue
      }
      const res = await this.applyObject(obj)
      this.childLogger.info(`Applied object ${obj.kind}/${obj.metadata.name} in namespace ${obj.metadata.namespace}`)
    }
  }

  private async doSyncIfFileChanges(app: ApplicationCrd, latestCommitSha: string) {
    await this.gitManager.fetchRepo(app)
    if (!(await this.gitManager.hasChanges(app, app.status?.lastSyncedCommit, latestCommitSha))) {
      this.childLogger.debug(`No file changes for application: ${app.metadata.name}`)
      return
    }
    const manifests = await this.gitManager.collectManifests(app, latestCommitSha)
    if (manifests.length === 0) {
      this.childLogger.debug(`No manifests found for application: ${app.metadata.name}`)
      return
    }
    await this.doSync(app, manifests)
  }

  private async doSyncIfNewCommit(app: ApplicationCrd) {
    const latestCommitSha = await this.gitManager.getLatestCommitSha(app)
    if (latestCommitSha === app.status?.lastSyncedCommit) {
      await this.updateStatus(app, {
        reason: 'SyncCompleted',
        message: `Application synced successfully at commit ${latestCommitSha}`,
        errors: [],
      })
      this.childLogger.debug(`No new commit for application: ${app.metadata.name}`)
      return
    }
    this.childLogger.debug(`New commit detected for application: ${app.metadata.name}, syncing...`)
    await this.doSyncIfFileChanges(app, latestCommitSha)
    await this.updateStatus(app, {
      lastSyncedCommit: latestCommitSha,
      reason: 'SyncCompleted',
      message: `Application synced successfully at commit ${latestCommitSha}`,
      errors: [],
    })
  }

  public async syncApplication(app: ApplicationCrd) {
    if (this.syncInProgress.has(app.metadata.uid)) {
      return
    }
    this.syncInProgress.add(app.metadata.uid)

    await this.updateStatus(app, {
      syncStatus: 'Syncing',
      lastSyncStartTime: new Date().toISOString(),
    })
    try {
      this.childLogger.debug(`Syncing application: ${app.metadata.name}`)
      await this.doSyncIfNewCommit(app)
      await this.updateStatus(app, {
        syncStatus: 'Synced',
        lastSyncEndTime: new Date().toISOString(),
      })
      this.childLogger.debug(`Finished syncing application: ${app.metadata.name}`)
    } catch (err) {
      logger.error({ err }, `Error syncing application: ${app.metadata.name}`)
      if (err instanceof SyncError) {
        await this.updateStatus(app, {
          syncStatus: 'OutOfSync',
          reason: err.reason,
          message: toStatusMessage(err.message),
          errors: err.errors.map((e) => ({ ...e, message: toStatusMessage(e.message) })),
        })
      } else {
        await this.updateStatus(app, {
          syncStatus: 'OutOfSync',
          reason: 'ErrorDuringSync',
          message: toStatusMessage((err as Error).message),
          errors: [],
        })
      }
    } finally {
      this.syncInProgress.delete(app.metadata.uid)
    }
  }

  public [Symbol.dispose]() {}
}

function toStatusMessage(text: string, maxLength = 1024): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine
}
