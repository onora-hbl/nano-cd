import { ApplicationCrdCache } from './ApplicationCrdCache.js'
import { GitManager } from './GitManager.js'
import { K8sInterface } from './K8sInterface.js'
import { SyncManager } from './SyncManager.js'
import { SyncScheduler } from './SyncScheduler.js'

export interface Container extends AsyncDisposable {
  readonly k8sInterface: K8sInterface
  readonly syncScheduler: SyncScheduler
  readonly gitManager: GitManager
  readonly syncManager: SyncManager
  readonly applicationCrdCache: ApplicationCrdCache
}

export async function createContainer(): Promise<Container> {
  await using stack = new AsyncDisposableStack()

  const k8sInterface = stack.use(new K8sInterface())
  const syncScheduler = stack.use(new SyncScheduler())
  const gitManager = stack.use(new GitManager())
  const syncManager = stack.use(new SyncManager(k8sInterface, gitManager))
  const applicationCrdCache = stack.use(new ApplicationCrdCache(k8sInterface, syncScheduler, syncManager))

  const resources = stack.move()

  return {
    k8sInterface,
    syncScheduler,
    gitManager,
    syncManager,
    applicationCrdCache,
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  }
}
