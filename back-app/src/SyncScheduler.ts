import type { ApplicationCrd } from './application.js'
import logger from './utils/logger.js'

type SyncCallback = () => Promise<void>

interface AppSchedule {
  interval: NodeJS.Timeout
  callback: SyncCallback
}

export class SyncScheduler implements Disposable {
  private childLogger
  private schedules = new Map<string, AppSchedule>()

  constructor() {
    this.childLogger = logger.child({ component: 'SyncScheduler' })
  }

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
    this.unschedule(application)

    const frequencyMs = this.parseDuration(application.spec.sync.interval)
    const interval = setInterval(() => {
      callback().catch((err: unknown) => {
        this.childLogger.error({ err }, `Scheduled sync failed: ${application.metadata.name}`)
      })
    }, frequencyMs)
    this.schedules.set(application.metadata.uid, { interval, callback })
  }

  public unschedule(application: ApplicationCrd) {
    const schedule = this.schedules.get(application.metadata.uid)
    if (schedule != null) {
      clearInterval(schedule.interval)
      this.schedules.delete(application.metadata.uid)
    }
  }

  public [Symbol.dispose]() {
    for (const { interval } of this.schedules.values()) {
      clearInterval(interval)
    }
    this.schedules.clear()
  }
}
