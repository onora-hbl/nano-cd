import { CustomObjectsApi, KubeConfig, V1ObjectMeta } from '@kubernetes/client-node'

export type Timestamp = string
export type Duration = `${number}${'s' | 'm' | 'h'}`

export type PersistedMetadata = V1ObjectMeta &
  Required<Pick<V1ObjectMeta, 'name' | 'namespace' | 'uid' | 'generation' | 'resourceVersion'>>

export class K8sInterface implements Disposable {
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
