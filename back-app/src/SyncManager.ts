import { ApiException, PatchStrategy, setHeaderOptions, type KubernetesObject } from '@kubernetes/client-node'
import {
  GROUP,
  PLURAL,
  VERSION,
  type ApplicationCrd,
  type ApplicationStatus,
  type ApplicationStatusError,
  type K8sObjectRef,
} from './application.js'
import { type GitManager } from './GitManager.js'
import type { K8sInterface } from './K8sInterface.js'
import logger from './utils/logger.js'
import { parseAllDocuments } from 'yaml'

export class SyncError extends Error {
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

  private applyPriority(object: KubernetesObject): number {
    if (object.kind === 'Namespace') return 0
    if (object.kind === 'CustomResourceDefinition') return 1
    return 2
  }

  private async treatObject(obj: any): Promise<K8sObjectRef> {
    let actualRes = null
    try {
      actualRes = await this.k8sInterface.ObjectApi.read(obj)
    } catch (err) {
      if (!(err instanceof ApiException && err.code === 404)) {
        throw err
      }
    }
    const appliedRes = await this.applyObject(obj)
    if (actualRes != null && actualRes.metadata?.resourceVersion === appliedRes.metadata?.resourceVersion) {
      this.childLogger.debug(
        `No changes for object ${obj.kind}/${obj.metadata.name} in namespace ${obj.metadata.namespace}`,
      )
    } else {
      this.childLogger.info(`Applied object ${obj.kind}/${obj.metadata.name} in namespace ${obj.metadata.namespace}`)
    }
    return {
      apiVersion: appliedRes.apiVersion,
      kind: appliedRes.kind,
      namespace: appliedRes.metadata?.namespace,
      name: appliedRes.metadata?.name,
    }
  }

  private async doSync(app: ApplicationCrd, manifests: string[]): Promise<K8sObjectRef[]> {
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
    const errors: ApplicationStatusError[] = []
    const k8sObjectRefs: K8sObjectRef[] = []
    for (const obj of objects) {
      obj.metadata ??= {}
      obj.metadata.labels ??= {}
      obj.metadata.labels['nano-cd/application'] = app.metadata.name
      try {
        const res = await this.treatObject(obj)
        k8sObjectRefs.push(res)
      } catch (e) {
        if (e instanceof ApiException) {
          errors.push({
            message: e.body?.message ?? e.message,
            object: {
              apiVersion: obj.apiVersion,
              kind: obj.kind,
              namespace: obj.metadata?.namespace,
              name: obj.metadata?.name,
            },
          })
        } else {
          errors.push({
            message: (e as Error).message,
            object: {
              apiVersion: obj.apiVersion,
              kind: obj.kind,
              namespace: obj.metadata?.namespace,
              name: obj.metadata?.name,
            },
          })
        }
      }
    }
    if (errors.length > 0) {
      throw new SyncError('Errors occurred during manifest application', 'ManifestApplyError', errors)
    }
    return k8sObjectRefs
  }

  private async prune(lastInventory: K8sObjectRef[], newInventory: K8sObjectRef[]) {
    const toPrune = []
    for (const obj of lastInventory) {
      if (
        !newInventory.some(
          (newObj) =>
            newObj.apiVersion === obj.apiVersion &&
            newObj.kind === obj.kind &&
            newObj.namespace === obj.namespace &&
            newObj.name === obj.name,
        )
      ) {
        toPrune.push(obj)
      }
    }
    toPrune.sort((a, b) => this.applyPriority(a) - this.applyPriority(b))
    toPrune.reverse()
    const errors: ApplicationStatusError[] = []
    for (const obj of toPrune) {
      try {
        this.childLogger.info(`Pruning object ${obj.kind}/${obj.name} in namespace ${obj.namespace}`)
        await this.k8sInterface.ObjectApi.delete({
          apiVersion: obj.apiVersion,
          kind: obj.kind,
          metadata: {
            name: obj.name,
            namespace: obj.namespace ?? 'default',
          },
        })
      } catch (e) {
        if (e instanceof ApiException && e.code === 404) {
          continue
        }
        if (e instanceof ApiException) {
          errors.push({
            message: e.body?.message ?? e.message,
            object: obj,
          })
        } else {
          errors.push({
            message: (e as Error).message,
            object: obj,
          })
        }
      }
    }
    if (errors.length > 0) {
      throw new SyncError('Errors occurred during pruning', 'PruneError', errors)
    }
  }

  private async doSyncIfFileChanges(app: ApplicationCrd, latestCommitSha: string): Promise<K8sObjectRef[] | null> {
    await this.gitManager.fetchRepo(app)
    if (!(await this.gitManager.hasChanges(app, app.status?.lastSyncedCommit, latestCommitSha))) {
      this.childLogger.debug(`No file changes for application: ${app.metadata.name}`)
      return null
    }
    const manifests = await this.gitManager.collectManifests(app, latestCommitSha)
    if (manifests.length === 0) {
      this.childLogger.debug(`No manifests found for application: ${app.metadata.name}`)
      return null
    }
    const newInventory = await this.doSync(app, manifests)

    if (app.spec.prune) {
      await this.prune(app.status?.inventory ?? [], newInventory)
    }

    return newInventory
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
    const res = await this.doSyncIfFileChanges(app, latestCommitSha)
    const newInventory = res ?? app.status?.inventory ?? []
    await this.updateStatus(app, {
      lastSyncedCommit: latestCommitSha,
      reason: 'SyncCompleted',
      message: `Application synced successfully at commit ${latestCommitSha}`,
      errors: [],
      inventory: newInventory,
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
