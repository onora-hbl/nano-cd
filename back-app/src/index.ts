import { buildApp } from './app.js'
import { createContainer } from './container.js'
import logger from './utils/logger.js'

const PORT = 3000
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const

async function main() {
  const container = await createContainer()
  const app = buildApp(container)

  // Services are disposed once the HTTP server has stopped
  app.addHook('onClose', () => container[Symbol.asyncDispose]())

  let closing: Promise<void> | undefined
  const shutdown = (signal: NodeJS.Signals) => {
    closing ??= (async () => {
      logger.info(`Received ${signal}, shutting down`)
      await app.close()
      logger.info('Nano CD stopped')
    })().catch((err: unknown) => {
      logger.error({ err }, 'Error while shutting down nano-cd')
      process.exitCode = 1
    })
  }
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, shutdown)
  }

  try {
    logger.debug('Routes tree:\n' + app.printRoutes())

    await app.listen({
      port: PORT,
    })
    logger.info(`Nano CD is running on port ${String(PORT)}`)

    await container.applicationCrdCache.initialize()
  } catch (err) {
    await app.close()
    throw err
  }
}

main().catch((err: unknown) => {
  logger.error(err, 'Error starting nano-cd')
  process.exitCode = 1
})
