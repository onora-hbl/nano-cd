import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { Duration, K8sInterface, PersistedMetadata, Timestamp } from './k8sPlugin.js'
import { makeInformer, type Informer, type KubernetesListObject, type KubernetesObject } from '@kubernetes/client-node'
import logger from './utils/logger.js'

declare module 'fastify' {
  interface FastifyInstance {
    applicationCrdCache: ApplicationCrdCache
  }
}

const GROUP = 'nanocd.ozyria.fr'
const VERSION = 'v1'
const PLURAL = 'applications'

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

export type ApplicationSyncStatus = 'Synced' | 'OutOfSync' | 'Unknown'

export interface ApplicationStatus {
  syncStatus?: ApplicationSyncStatus
  lastSyncedCommit?: string
  lastSyncTime?: Timestamp
}

export interface ApplicationCrd extends KubernetesObject {
  metadata: PersistedMetadata
  spec: ApplicationSpec
  status?: ApplicationStatus
}

export class ApplicationCrdCache {
  private informer: Informer<ApplicationCrd> | null = null
  private childLogger

  constructor(private k8sInterface: K8sInterface) {
    this.childLogger = logger.child({ component: 'ApplicationCrdCache' })
  }

  private onAdd(app: ApplicationCrd) {
    this.childLogger.debug('Application added: %o', app)
  }

  private onUpdate(app: ApplicationCrd) {
    this.childLogger.debug('Application updated: %o', app)
  }

  private onDelete(app: ApplicationCrd) {
    this.childLogger.debug('Application deleted: %o', app)
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
    this.informer.on('error', (err) => {
      this.childLogger.error({ err }, 'Error in informer')
      setTimeout(() => this.informer?.start(), 5000)
    })

    await this.informer.start()
  }

  public async [Symbol.asyncDispose]() {
    if (this.informer != null) {
      await this.informer.stop()
    }
  }
}

const ApplicationCrdCachePlugin: FastifyPluginAsync = async (fastify) => {
  const applicationCrdCache = new ApplicationCrdCache(fastify.k8sInterface)

  fastify.decorate('applicationCrdCache', applicationCrdCache)

  fastify.addHook('onClose', (_instance, done) => {
    applicationCrdCache[Symbol.asyncDispose]().catch((err) => {
      logger.error({ err }, 'Error while disposing ApplicationCrdCache')
    })
    done()
  })
}

export default fp(ApplicationCrdCachePlugin)
