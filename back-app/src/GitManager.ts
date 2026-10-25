import logger from './utils/logger.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ApplicationCrd } from './application.js'
import { existsSync } from 'node:fs'

const exec = promisify(execFile)

type GitTokenFactory = () => string

class GitRepo {
  constructor(
    private readonly url: string,
    private readonly localDir: string,
    private readonly tokenFactory?: GitTokenFactory,
  ) {}

  private latestCommitPromise: Record<string, Promise<string>> = {}
  public async latestCommit(branch: string): Promise<string> {
    let currentRequest = this.latestCommitPromise[branch]
    if (currentRequest != null) {
      return await currentRequest
    }

    currentRequest = new Promise(async (resolve) => {
      const output = await this.git('ls-remote', this.url, `refs/heads/${branch}`)
      const sha = output.split('\t')[0]
      if (sha == null) {
        throw new Error(`Branch not found: ${branch}`)
      }
      resolve(sha)
    })
    this.latestCommitPromise[branch] = currentRequest
    const res = await currentRequest
    delete this.latestCommitPromise[branch]
    return res
  }

  private fetchPromise: Promise<void> | null = null
  async fetch(branch: string): Promise<void> {
    let currentRequest = this.fetchPromise
    if (currentRequest != null) {
      return await currentRequest
    }

    currentRequest = new Promise(async (resolve) => {
      if (!existsSync(this.localDir)) await this.git('init', '--bare', this.localDir)
      await this.gitIn('fetch', this.url, `+refs/heads/${branch}:refs/heads/${branch}`)
      resolve()
    })
    this.fetchPromise = currentRequest
    await currentRequest
    this.fetchPromise = null
  }

  async hasCommit(sha: string): Promise<boolean> {
    try {
      await this.gitIn('cat-file', '-e', `${sha}^{commit}`)
      return true
    } catch {
      return false
    }
  }

  async listFiles(sha: string, path: string): Promise<string[]> {
    const output = await this.gitIn('ls-tree', '-r', '--name-only', sha, '--', path)
    return output.split('\n').filter(Boolean)
  }

  async readFile(sha: string, file: string): Promise<string> {
    return this.gitIn('cat-file', 'blob', `${sha}:${file}`)
  }

  async changedFiles(from: string, to: string, path: string): Promise<string[]> {
    const output = await this.gitIn('diff', '--name-only', from, to, '--', path)
    return output.split('\n').filter(Boolean)
  }

  private hasChangesPromise: Promise<boolean> | null = null
  async hasChanges(from: string | undefined, to: string, path: string): Promise<boolean> {
    let currentRequest = this.hasChangesPromise
    if (currentRequest != null) {
      return await currentRequest
    }

    currentRequest = new Promise(async (resolve) => {
      if (!from || from === to) return from !== to
      if (!(await this.hasCommit(from))) return true
      resolve((await this.changedFiles(from, to, path)).length > 0)
    })

    this.hasChangesPromise = currentRequest
    const res = await currentRequest
    this.hasChangesPromise = null
    return res
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
      const localPath =
        '/tmp/nanocd/repositories/' + app.spec.repo.replaceAll('/', '_').replaceAll(':', '_').replaceAll('.', '_')
      this.repoCache[key] = new GitRepo(
        app.spec.repo,
        localPath,
        app.spec.authSecretRef == null ? undefined : () => app.spec.authSecretRef!,
      )
      this.childLogger.debug(`Created GitRepo for ${key} with localDir ${localPath}`)
    }
    return this.repoCache[key]!
  }

  public async getLatestCommitSha(app: ApplicationCrd): Promise<string> {
    const repo = this.getOrCreateRepo(app)
    const latestCommit = await repo.latestCommit(app.spec.branch)
    return latestCommit
  }

  public async fetchRepo(app: ApplicationCrd): Promise<void> {
    const repo = this.getOrCreateRepo(app)
    await repo.fetch(app.spec.branch)
  }

  public async hasChanges(app: ApplicationCrd, from: string | undefined, to: string): Promise<boolean> {
    const repo = this.getOrCreateRepo(app)
    return await repo.hasChanges(from, to, app.spec.source.path)
  }

  public async collectManifests(app: ApplicationCrd, head: string): Promise<string[]> {
    const repo = this.getOrCreateRepo(app)
    const fileNames = await repo
      .listFiles(head, app.spec.source.path)
      .then((files) => files.filter((file) => file.endsWith('.yaml') || file.endsWith('.yml')))
    return Promise.all(fileNames.map((file) => repo.readFile(head, file)))
  }

  public [Symbol.dispose]() {}
}
