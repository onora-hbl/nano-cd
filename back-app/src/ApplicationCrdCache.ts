import { makeInformer, type Informer, type KubernetesListObject } from '@kubernetes/client-node'
import { GROUP, PLURAL, VERSION, type ApplicationCrd } from './application.js'
import type { K8sInterface } from './K8sInterface.js'
import type { SyncManager } from './SyncManager.js'
import type { SyncScheduler } from './SyncScheduler.js'
import logger from './utils/logger.js'

const INFORMER_RESTART_DELAY_MS = 5000

export class ApplicationCrdCache implements AsyncDisposable {
  private informer: Informer<ApplicationCrd> | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private disposed = false
  private childLogger
  private cache = new Map<string, ApplicationCrd>()

  constructor(
    private k8sInterface: K8sInterface,
    private syncScheduler: SyncScheduler,
    private syncManager: SyncManager,
  ) {
    this.childLogger = logger.child({ component: 'ApplicationCrdCache' })
  }

  private async syncApp(uid: string) {
    const app = this.cache.get(uid)
    if (app == null) {
      return
    }

    await this.syncManager.syncApplication(app)
  }

  private onAdd(app: ApplicationCrd) {
    this.childLogger.debug(`Application added: ${app.metadata.name}`)
    this.cache.set(app.metadata.uid, app)
    this.syncScheduler.schedule(app, () => this.syncApp(app.metadata.uid))
  }

  private onUpdate(app: ApplicationCrd) {
    if (app.metadata.deletionTimestamp != null) {
      return
    }
    if (app.status?.lastObservedGeneration === app.metadata.generation) {
      this.syncScheduler.schedule(app, () => this.syncApp(app.metadata.uid))
    }
    this.cache.set(app.metadata.uid, app)
  }

  private onDelete(app: ApplicationCrd) {
    this.childLogger.debug(`Application deleted: ${app.metadata.name}`)
    this.cache.delete(app.metadata.uid)
    this.syncScheduler.unschedule(app)
  }

  private onError(err: unknown) {
    if (this.disposed) {
      return
    }
    this.childLogger.error({ err }, 'Error in informer')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.informer?.start().catch((err: unknown) => {
        this.onError(err)
      })
    }, INFORMER_RESTART_DELAY_MS)
  }

  public async initialize() {
    const listApplications = () =>
      this.k8sInterface.CustomObjectApi.listClusterCustomObject({
        group: GROUP,
        version: VERSION,
        plural: PLURAL,
      }) as Promise<KubernetesListObject<ApplicationCrd>>

    this.informer = makeInformer<ApplicationCrd>(
      this.k8sInterface.KubeConfig,
      `/apis/${GROUP}/${VERSION}/${PLURAL}`,
      listApplications,
    )

    this.informer.on('add', this.onAdd.bind(this))
    this.informer.on('update', this.onUpdate.bind(this))
    this.informer.on('delete', this.onDelete.bind(this))
    this.informer.on('error', this.onError.bind(this))

    await this.informer.start()
  }

  public async [Symbol.asyncDispose]() {
    this.disposed = true
    if (this.restartTimer != null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    await this.informer?.stop()
  }
}
