import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { ApplicationCrd } from './ApplicationCrdCache.js'
import type { K8sInterface } from './k8sPlugin.js'
import logger from './utils/logger.js'

declare module 'fastify' {
  interface FastifyInstance {
    syncManager: SyncManager
  }
}

export class SyncManager {
  private childLogger
  private syncInProgress: Record<string, boolean> = {}

  constructor(private k8sInterface: K8sInterface) {
    this.childLogger = logger.child({ component: 'SyncManager' })
  }

  public async syncApplication(app: ApplicationCrd) {
    if (this.syncInProgress[app.metadata.uid] === true) {
      return
    }
    this.syncInProgress[app.metadata.uid] = true

    this.childLogger.debug(`Syncing application: ${app.metadata.name}`)

    this.syncInProgress[app.metadata.uid] = false
  }

  public async [Symbol.dispose]() {}
}

const SyncManagerPlugin: FastifyPluginAsync = async (fastify) => {
  const syncManager = new SyncManager(fastify.k8sInterface)

  fastify.decorate('syncManager', syncManager)

  fastify.addHook('onClose', (_instance, done) => {
    syncManager[Symbol.dispose]()
    done()
  })
}

export default fp(SyncManagerPlugin)
