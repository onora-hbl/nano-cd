import type { ApplicationCrd } from './application.js'
import type { K8sInterface } from './K8sInterface.js'
import logger from './utils/logger.js'

export class SyncManager implements Disposable {
  private childLogger
  private syncInProgress = new Set<string>()

  constructor(private k8sInterface: K8sInterface) {
    this.childLogger = logger.child({ component: 'SyncManager' })
  }

  public async syncApplication(app: ApplicationCrd) {
    if (this.syncInProgress.has(app.metadata.uid)) {
      return
    }
    this.syncInProgress.add(app.metadata.uid)

    try {
      this.childLogger.debug(`Syncing application: ${app.metadata.name}`)
    } finally {
      this.syncInProgress.delete(app.metadata.uid)
    }
  }

  public [Symbol.dispose]() {}
}
