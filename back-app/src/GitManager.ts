import logger from './utils/logger.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ApplicationCrd } from './application.js'
import { existsSync } from 'node:fs'
import { v4 as uuid } from 'uuid'

const exec = promisify(execFile)

type GitTokenFactory = () => string

class GitRepo {
  constructor(
    private readonly url: string,
    public readonly localDir: string,
    private readonly tokenFactory?: GitTokenFactory,
  ) {}

  public async latestCommit(branch: string): Promise<string> {
    const output = await this.git('ls-remote', this.url, `refs/heads/${branch}`)
    const sha = output.split('\t')[0]
    if (sha == null) {
      throw new Error(`Branch not found: ${branch}`)
    }
    return sha
  }

  public async fetch(branch: string): Promise<void> {
    if (!existsSync(this.localDir)) await this.git('init', '--bare', this.localDir)
    await this.gitIn('fetch', this.url, `+refs/heads/${branch}:refs/heads/${branch}`)
  }

  private async hasCommit(sha: string): Promise<boolean> {
    try {
      await this.gitIn('cat-file', '-e', `${sha}^{commit}`)
      return true
    } catch {
      return false
    }
  }

  public async listFiles(sha: string, path: string): Promise<string[]> {
    const output = await this.gitIn('ls-tree', '-r', '--name-only', sha, '--', path)
    return output.split('\n').filter(Boolean)
  }

  public async readFile(sha: string, file: string): Promise<string> {
    return this.gitIn('cat-file', 'blob', `${sha}:${file}`)
  }

  private async changedFiles(from: string, to: string, path: string): Promise<string[]> {
    const output = await this.gitIn('diff', '--name-only', from, to, '--', path)
    return output.split('\n').filter(Boolean)
  }

  public async hasChanges(from: string | undefined, to: string, path: string): Promise<boolean> {
    if (!from || from === to) return from !== to
    if (!(await this.hasCommit(from))) return true
    return (await this.changedFiles(from, to, path)).length > 0
  }

  private gitIn(...args: string[]): Promise<string> {
    return this.git('-C', this.localDir, ...args)
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, { env: this.env(), maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    if (this.tokenFactory == null) {
      return env
    }
    const credentials = Buffer.from(`x-access-token:${this.tokenFactory()}`).toString('base64')
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${credentials}`
    return env
  }
}

export class GitManager implements Disposable {
  private childLogger
  private repoCache: Record<string, GitRepo> = {}

  constructor() {
    this.childLogger = logger.child({ component: 'GitManager' })
  }

  private getOrCreateRepo(app: ApplicationCrd): GitRepo {
    const key = `${app.spec.repo}:${app.spec.authSecretRef ?? 'NO_TOKEN'}`
    if (this.repoCache[key] == null) {
      const localPath = '/tmp/nanocd/repositories/' + uuid()
      this.repoCache[key] = new GitRepo(
        app.spec.repo,
        localPath,
        app.spec.authSecretRef == null ? undefined : () => app.spec.authSecretRef!,
      )
      this.childLogger.debug(`Created GitRepo for ${key} with localDir ${localPath}`)
    }
    return this.repoCache[key]!
  }

  private getlatestCommitShaPromises: Record<string, Promise<string>> = {}
  public async getLatestCommitSha(app: ApplicationCrd): Promise<string> {
    const repo = this.getOrCreateRepo(app)
    let promise = this.getlatestCommitShaPromises[repo.localDir]
    if (promise != null) {
      return await promise
    }

    promise = repo.latestCommit(app.spec.branch)
    this.getlatestCommitShaPromises[repo.localDir] = promise
    const latestCommit = await promise
    delete this.getlatestCommitShaPromises[repo.localDir]
    return latestCommit
  }

  private fetchPromises: Record<string, Promise<void>> = {}
  public async fetchRepo(app: ApplicationCrd): Promise<void> {
    const repo = this.getOrCreateRepo(app)
    let promise = this.fetchPromises[repo.localDir]
    if (promise != null) {
      await promise
      return
    }

    promise = repo.fetch(app.spec.branch)
    this.fetchPromises[repo.localDir] = promise
    await promise
    delete this.fetchPromises[repo.localDir]
  }

  private hasChangesPromises: Record<string, Promise<boolean>> = {}
  public async hasChanges(app: ApplicationCrd, from: string | undefined, to: string): Promise<boolean> {
    const repo = this.getOrCreateRepo(app)
    let promise = this.hasChangesPromises[repo.localDir]
    if (promise != null) {
      return await promise
    }

    promise = repo.hasChanges(from, to, app.spec.source.path)
    this.hasChangesPromises[repo.localDir] = promise
    const hasChanges = await promise
    delete this.hasChangesPromises[repo.localDir]
    return hasChanges
  }

  private collectManifestsPromises: Record<string, Promise<string[]>> = {}
  public async collectManifests(app: ApplicationCrd, head: string): Promise<string[]> {
    const repo = this.getOrCreateRepo(app)
    let promise = this.collectManifestsPromises[repo.localDir]
    if (promise != null) {
      return await promise
    }

    promise = new Promise(async (resolve) => {
      const fileNames = await repo
        .listFiles(head, app.spec.source.path)
        .then((files) => files.filter((file) => file.endsWith('.yaml') || file.endsWith('.yml')))
      const manifests = await Promise.all(fileNames.map((file) => repo.readFile(head, file)))
      resolve(manifests)
    })
    this.collectManifestsPromises[repo.localDir] = promise
    const manifests = await promise
    delete this.collectManifestsPromises[repo.localDir]
    return manifests
  }

  public [Symbol.dispose]() {}
}
