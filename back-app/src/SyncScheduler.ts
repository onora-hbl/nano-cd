import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { ApplicationCrd } from './ApplicationCrdCache.js'

declare module 'fastify' {
  interface FastifyInstance {
    syncScheduler: SyncScheduler
  }
}

type SyncCallback = () => Promise<void>

interface AppSchedule {
  interval: NodeJS.Timeout
  callback: SyncCallback
}

export class SyncScheduler {
  private schedules: Record<string, AppSchedule> = {}

  private parseDuration(duration: string): number {
    const unit = duration.slice(-1)
    const value = parseInt(duration.slice(0, -1), 10)
    if (isNaN(value)) {
      throw new Error(`Invalid duration value: ${duration}`)
    }

    if (unit === 's') return value * 1000
    if (unit === 'm') return value * 60 * 1000
    if (unit === 'h') return value * 60 * 60 * 1000

    throw new Error(`Invalid duration unit: ${unit}`)
  }

  public schedule(application: ApplicationCrd, callback: SyncCallback) {
    if (this.schedules[application.metadata.uid] != null) {
      clearInterval(this.schedules[application.metadata.uid]!.interval)
      delete this.schedules[application.metadata.uid]
    }

    const frequencyMs = this.parseDuration(application.spec.sync.interval)
    const interval = setInterval(callback, frequencyMs)
    this.schedules[application.metadata.uid] = {
      interval,
      callback,
    }
  }

  public unschedule(application: ApplicationCrd) {
    if (this.schedules[application.metadata.uid] != null) {
      clearInterval(this.schedules[application.metadata.uid]!.interval)
      delete this.schedules[application.metadata.uid]
    }
  }

  public async [Symbol.dispose]() {
    for (const uid in this.schedules) {
      clearInterval(this.schedules[uid]!.interval)
    }
  }
}

const SyncSchedulerPlugin: FastifyPluginAsync = async (fastify) => {
  const syncScheduler = new SyncScheduler()

  fastify.decorate('syncScheduler', syncScheduler)

  fastify.addHook('onClose', (_instance, done) => {
    syncScheduler[Symbol.dispose]()
    done()
  })
}

export default fp(SyncSchedulerPlugin)
