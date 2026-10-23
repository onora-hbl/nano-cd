import { CustomObjectsApi, KubeConfig, V1ObjectMeta } from '@kubernetes/client-node'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    k8sInterface: K8sInterface
  }
}

export type Timestamp = string
export type Duration = `${number}${'s' | 'm' | 'h'}`

export type PersistedMetadata = V1ObjectMeta &
  Required<Pick<V1ObjectMeta, 'name' | 'namespace' | 'uid' | 'generation' | 'resourceVersion'>>

export class K8sInterface {
  private customObjectApi
  private kc

  constructor() {
    this.kc = new KubeConfig()
    this.kc.loadFromDefault()
    this.customObjectApi = this.kc.makeApiClient(CustomObjectsApi)
  }

  public get CustomObjectApi() {
    return this.customObjectApi
  }

  public get KubeConfig() {
    return this.kc
  }

  public [Symbol.dispose]() {}
}

const K8sInterfacePlugin: FastifyPluginAsync = async (fastify) => {
  const k8sInterface = new K8sInterface()

  fastify.decorate('k8sInterface', k8sInterface)

  fastify.addHook('onClose', (_instance, done) => {
    k8sInterface[Symbol.dispose]()
    done()
  })
}

export default fp(K8sInterfacePlugin)
