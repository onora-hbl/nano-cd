import logger from './utils/logger.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ApplicationCrd } from './application.js'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { SyncError } from './SyncManager.js'

const exec = promisify(execFile)

const REPOSITORIES_DIR = '/tmp/nanocd/repositories'

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
    try {
      const { stdout } = await exec('git', args, { env: this.env(), maxBuffer: 64 * 1024 * 1024 })
      return stdout.trim()
    } catch (e) {
      throw new SyncError((e as Error).message ?? 'Unknown error', 'GitError', [])
    }
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
  private inflight = new Map<string, Promise<unknown>>()

  constructor() {
    this.childLogger = logger.child({ component: 'GitManager' })
  }

  private getOrCreateRepo(app: ApplicationCrd): GitRepo {
    const key = `${app.spec.repo}:${app.spec.authSecretRef ?? 'NO_TOKEN'}`
    if (this.repoCache[key] == null) {
      const localPath = join(REPOSITORIES_DIR, createHash('sha256').update(key).digest('hex'))
      this.repoCache[key] = new GitRepo(
        app.spec.repo,
        localPath,
        app.spec.authSecretRef == null ? undefined : () => app.spec.authSecretRef!,
      )
      this.childLogger.debug(`Created GitRepo for ${app.spec.repo} with localDir ${localPath}`)
    }
    return this.repoCache[key]!
  }

  private dedupe<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.inflight.get(key)
    if (pending != null) {
      return pending as Promise<T>
    }
    const promise = operation().finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return promise
  }

  public getLatestCommitSha(app: ApplicationCrd): Promise<string> {
    const repo = this.getOrCreateRepo(app)
    return this.dedupe(`latestCommit:${repo.localDir}:${app.spec.branch}`, () => repo.latestCommit(app.spec.branch))
  }

  public fetchRepo(app: ApplicationCrd): Promise<void> {
    const repo = this.getOrCreateRepo(app)
    return this.dedupe(`fetch:${repo.localDir}:${app.spec.branch}`, () => repo.fetch(app.spec.branch))
  }

  public hasChanges(app: ApplicationCrd, from: string | undefined, to: string): Promise<boolean> {
    const repo = this.getOrCreateRepo(app)
    const path = app.spec.source.path
    return this.dedupe(`hasChanges:${repo.localDir}:${from ?? ''}:${to}:${path}`, () => repo.hasChanges(from, to, path))
  }

  public collectManifests(app: ApplicationCrd, head: string): Promise<string[]> {
    const repo = this.getOrCreateRepo(app)
    const path = app.spec.source.path
    return this.dedupe(`collectManifests:${repo.localDir}:${head}:${path}`, async () => {
      const files = await repo.listFiles(head, path)
      const fileNames = files.filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
      return Promise.all(fileNames.map((file) => repo.readFile(head, file)))
    })
  }

  public [Symbol.dispose]() {}
}
