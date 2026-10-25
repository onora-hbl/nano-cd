import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node'
import {
  GROUP,
  PLURAL,
  VERSION,
  type ApplicationCrd,
  type ApplicationStatus,
  type ApplicationSyncStatus,
} from './application.js'
import { type GitManager } from './GitManager.js'
import type { K8sInterface } from './K8sInterface.js'
import logger from './utils/logger.js'

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

  private async doSync(app: ApplicationCrd, manifests: string[]) {
    this.childLogger.info(`Syncing application: ${app.metadata.name} with ${manifests.length} manifests`)
    manifests.forEach((manifest) => console.log(manifest))
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
    this.doSync(app, manifests)
  }

  private async doSyncIfNewCommit(app: ApplicationCrd) {
    const latestCommitSha = await this.gitManager.getLatestCommitSha(app)
    if (latestCommitSha === app.status?.lastSyncedCommit) {
      this.childLogger.debug(`No new commit for application: ${app.metadata.name}`)
      return
    }
    this.childLogger.debug(`New commit detected for application: ${app.metadata.name}, syncing...`)
    await this.updateStatus(app, {
      syncStatus: 'Syncing',
    })
    await this.doSyncIfFileChanges(app, latestCommitSha)
    await this.updateStatus(app, {
      syncStatus: 'Synced',
      lastSyncedCommit: latestCommitSha,
    })
  }

  public async syncApplication(app: ApplicationCrd) {
    if (this.syncInProgress.has(app.metadata.uid)) {
      return
    }
    this.syncInProgress.add(app.metadata.uid)

    try {
      this.childLogger.debug(`Syncing application: ${app.metadata.name}`)
      await this.doSyncIfNewCommit(app)
      this.childLogger.debug(`Finished syncing application: ${app.metadata.name}`)
      await this.updateStatus(app, { lastObservedGeneration: app.metadata.generation })
    } finally {
      this.syncInProgress.delete(app.metadata.uid)
    }
  }

  public [Symbol.dispose]() {}
}
