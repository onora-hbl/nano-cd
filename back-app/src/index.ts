import type { JsonSchemaToTsProvider } from '@fastify/type-provider-json-schema-to-ts'
import Fastify, { type FastifyError } from 'fastify'
import { NanoCdError } from './utils/errors.js'
import logger from './utils/logger.js'
import k8sInterfacePlugin from './k8sPlugin.js'
import applicationCrdCachePlugin from './ApplicationCrdCache.js'
import syncSchedulerPlugin from './SyncScheduler.js'
import syncManagerPlugin from './SyncManager.js'

const PORT = 3000

let isAppReady = false

async function main() {
  const app = Fastify().withTypeProvider<JsonSchemaToTsProvider>()

  app.addHook('onReady', () => {
    isAppReady = true
  })

  await app.register(k8sInterfacePlugin)
  await app.register(syncSchedulerPlugin)
  await app.register(syncManagerPlugin)
  await app.register(applicationCrdCachePlugin)

  app.setErrorHandler<FastifyError | NanoCdError | Error>((error, request, reply) => {
    if (error instanceof NanoCdError) {
      return error.writeReply(reply)
    }
    if ('validation' in error) {
      const err = {
        code: 'BAD_REQUEST',
        message: 'Invalid request data - ' + JSON.stringify(error.validation),
      }
      return reply.status(400).send(err)
    }
    logger.error({ err: error }, `Error in request ${request.method} ${request.url}`)
    const errorResponse = {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    }
    return reply.status(500).send(errorResponse)
  })

  app.route({
    method: 'GET',
    url: '/health',
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: {
              enum: ['ok'],
            },
          },
          required: ['status'],
          additionalProperties: false,
        },
        503: {
          type: 'object',
          properties: {
            code: {
              enum: ['NOT_READY'],
            },
            message: {
              type: 'string',
            },
          },
          required: ['code', 'message'],
          additionalProperties: false,
        },
      },
    },
    handler: async (_, reply) => {
      if (isAppReady) {
        return reply.code(200).send({ status: 'ok' })
      }
      return reply.code(503).send({ code: 'NOT_READY', message: 'Nano CD is not ready yet' })
    },
  })

  logger.debug('Routes tree:\n' + app.printRoutes())

  await app.listen({
    port: PORT,
  })
  logger.info(`Nano CD is running on port ${String(PORT)}`)

  await app.applicationCrdCache.initialize()
}

main().catch((err: unknown) => {
  logger.error(err, 'Error starting nano-cd')
  process.exitCode = 1
})
