// What the Worker does with the data repository for one person: their branches and pull requests (the submissions), commits
// of several files at once, comments, checks, and what changed on the base branch. Everything runs with the person's own
// token (see github.ts). What differs between the editors is handed in (`RepoOptions`).

import { GitHubError, call } from './github.js'

export interface RepoFile {
  path: string
  content: string
}

export interface Pull {
  number: number
  url: string
  state: 'open' | 'closed'
  merged: boolean
  /** A draft cannot be merged and does not ask anybody to review it. */
  draft: boolean
}

interface OpenPull {
  number: number
  html_url: string
  node_id: string
  draft?: boolean
}

/** A pull request as the list of GitHub gives it (only what is read). */
export interface ListedPull {
  number: number
  html_url: string
  state: 'open' | 'closed'
  merged_at: string | null
  draft?: boolean
  title: string
  body: string | null
  created_at: string
  head: { ref: string; sha: string }
}

/** A pull request by its number, as far as the review needs it. */
export interface PullInfo {
  number: number
  node_id: string
  html_url: string
  state: 'open' | 'closed'
  merged: boolean
  draft?: boolean
  /** GitHub works this out when asked; null until it has. */
  mergeable: boolean | null
  title: string
  head: { ref: string; sha: string }
  base: { ref: string }
}

/** How the automatic checks of a commit (the validation of the data) stand: none, still running, failed, or all green. */
export type Checks = 'none' | 'pending' | 'failure' | 'success' | 'unknown'

/** A comment as GitHub gives it (an ordinary one on the pull request, or one on a line of a file in it). */
export interface RawComment {
  id: number
  body: string
  created_at: string
  updated_at: string
  user: { login: string; avatar_url: string } | null
  /** Only for a comment on a file. */
  path?: string
  /** Only for the comment of an issue or pull request, as asked for by its number. */
  issue_url?: string
}

/** 100 comments a page; a submission is discussed by a few people, so this is far more than needed. */
const MAX_COMMENT_PAGES = 5

/** The compare API shows at most 300 files. */
const MAX_CHANGE_PAGES = 3

export interface ChangedFile {
  filename: string
  status: string
  sha: string
  previous_filename?: string
}

/** 100 files a page; a submission holds a few dozen objects, so this is far more than needed. */
const MAX_FILE_PAGES = 10

/** What differs between the editors: which branches are submissions, which files a submission may change, and how they are called. */
export interface RepoOptions {
  /** Whether a branch is one of the submissions of this editor (`erfassung/anna/fest`). */
  isSubmissionBranch(branch: string): boolean
  /** Whether a file may be part of a submission that is accepted here (the others are refused). */
  isEntryFile(path: string): boolean
  /** What a submission is called in messages ("Erfassung", "Einreichung"; feminine). */
  submission: string
  /** What its files are called in messages, in the plural ("Objekte", "Einträge"). */
  entries: string
}

/** One person's work on the data repository: their own branch and its pull request. */
export class Repo {
  constructor(
    private token: string,
    private repo: string,
    private base: string,
    private fetchFn: typeof fetch,
    private options: RepoOptions,
  ) {}

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return call<T>(this.fetchFn, this.token, method, `/repos/${this.repo}${path}`, body)
  }

  /** The commit a branch points to, or null if there is no such branch. */
  private async head(branch: string): Promise<string | null> {
    try {
      return (await this.call<{ object: { sha: string } }>('GET', `/git/ref/heads/${branch}`)).object.sha
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null
      throw error
    }
  }

  /** Whether the path exists in the tree of the commit. */
  private async exists(path: string, commit: string): Promise<boolean> {
    try {
      await this.call('GET', `/contents/${path}?ref=${commit}`)
      return true
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false
      throw error
    }
  }

  /**
   * Puts the files into one commit on the branch (created from the base branch if it does not exist) and
   * removes the paths in `removals` that exist there. Returns the commit's hash, or null if there was
   * nothing to change. If someone else moved the branch meanwhile, it is tried once more, unless the caller said which commit
   * it saw (`expected`): then a moved branch is a 409.
   */
  /** `message` may be made from the paths that were really removed (those that were not there are left out). */
  async save(branch: string, files: RepoFile[], removals: string[], message: string | ((removed: string[]) => string), expected?: string): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      const head = await this.head(branch)
      // The caller saw the branch at `expected`: if it moved since, somebody else's work is not seen yet, and nothing is written over it.
      if (expected && head && head !== expected) throw new GitHubError('Der Branch hat sich geändert.', 409)
      let from = head
      if (!from) {
        from = await this.head(this.base)
        if (!from) throw new GitHubError(`The branch ${this.base} does not exist.`, 404)
      }
      const gone: string[] = []
      for (const path of removals) if (await this.exists(path, from)) gone.push(path)
      if (files.length === 0 && gone.length === 0) return null

      const parent = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${from}`)
      const tree = await this.call<{ sha: string }>('POST', '/git/trees', {
        base_tree: parent.tree.sha,
        tree: [
          ...files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
          ...gone.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
        ],
      })
      // Nothing differs from what is there: no commit (and no branch that would only point at the base).
      if (tree.sha === parent.tree.sha) return null
      if (!head) await this.call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: from })
      const commit = await this.call<{ sha: string }>('POST', '/git/commits', { message: typeof message === 'function' ? message(gone) : message, tree: tree.sha, parents: [from] })
      try {
        await this.call('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha })
        return commit.sha
      } catch (error) {
        const raced = error instanceof GitHubError && (error.status === 422 || error.status === 409)
        if (!raced || attempt >= 1) throw error
        if (expected) throw new GitHubError('Der Branch hat sich geändert.', 409)
      }
    }
  }

  /** The open pull request of the branch, draft or not. */
  async current(branch: string): Promise<Pull | undefined> {
    const open = await this.openPull(branch)
    return open ? Repo.view(open) : undefined
  }

  /** Gives the open pull request of the branch a new title and text. Returns nothing if there is none. */
  async rename(branch: string, title: string, body: string): Promise<Pull | undefined> {
    const open = await this.openPull(branch)
    if (!open) return undefined
    await this.call('PATCH', `/pulls/${open.number}`, { title, body })
    return Repo.view(open)
  }

  private async openPull(branch: string): Promise<OpenPull | undefined> {
    const owner = this.repo.split('/')[0]
    const open = await this.call<OpenPull[]>('GET', `/pulls?state=open&base=${this.base}&head=${owner}:${branch}`)
    return open[0]
  }

  private static view(pull: OpenPull): Pull {
    return { number: pull.number, url: pull.html_url, state: 'open', merged: false, draft: pull.draft === true }
  }

  /**
   * The open pull request of the branch; if there is none, a new one as a draft. Returns nothing if
   * GitHub does not want one (e.g. the branch has no commit that is not in the base branch yet).
   */
  async draft(branch: string, title: string, body: string): Promise<Pull | undefined> {
    const existing = await this.openPull(branch)
    if (existing) return Repo.view(existing)
    try {
      const created = await this.call<OpenPull>('POST', '/pulls', { title, head: branch, base: this.base, body, draft: true })
      return Repo.view({ ...created, draft: true })
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) return undefined
      throw error
    }
  }

  /**
   * Asks for a review: the draft of the branch is marked ready. If the branch has no pull request yet,
   * a new one is opened (not as a draft). Throws a 409 if there is nothing to submit.
   */
  async submit(branch: string, title: string, body: string): Promise<Pull> {
    const existing = await this.openPull(branch)
    if (existing?.draft) {
      const answer = await call<{ errors?: { message: string }[] }>(this.fetchFn, this.token, 'POST', '/graphql', {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }',
        variables: { id: existing.node_id },
      })
      if (answer.errors?.length) throw new GitHubError(answer.errors[0].message, 502)
      return Repo.view({ ...existing, draft: false })
    }
    if (existing) return Repo.view(existing)
    try {
      const created = await this.call<OpenPull>('POST', '/pulls', { title, head: branch, base: this.base, body })
      return Repo.view({ ...created, draft: false })
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) throw new GitHubError('There is nothing new to submit.', 409)
      throw error
    }
  }

  /** The newest pull requests (open, closed, merged) to the base branch; the caller picks the ones that are submissions. */
  async pulls(): Promise<ListedPull[]> {
    return this.call<ListedPull[]>('GET', `/pulls?state=all&base=${this.base}&sort=created&direction=desc&per_page=100`)
  }

  /** The pull request with this number (any; `sessionPull` is for those that are submissions). */
  async info(number: number): Promise<PullInfo> {
    return this.call<PullInfo>('GET', `/pulls/${number}`)
  }

  /** What the pull request changes: the pull request itself and the files it adds, changes or removes. */
  async pullFiles(number: number): Promise<{ head: string; pull: PullInfo; files: { filename: string; status: string }[] }> {
    const pull = await this.info(number)
    const files: { filename: string; status: string }[] = []
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const batch = await this.call<{ filename: string; status: string }[]>('GET', `/pulls/${number}/files?per_page=100&page=${page}`)
      files.push(...batch)
      if (batch.length < 100) break
    }
    return { head: pull.head.sha, pull, files }
  }

  /** The pull request of a submission: only those can be handled here (their branch is made by this editor, they go to the base branch). */
  private async sessionPull(number: number): Promise<PullInfo> {
    const info = await this.info(number)
    if (!this.options.isSubmissionBranch(info.head.ref) || info.base.ref !== this.base) {
      throw new GitHubError(`Das ist keine ${this.options.submission}.`, 404)
    }
    return info
  }

  /** A pull request that waits for review: open and not a draft. Anything else is a 409 with the reason. */
  private async waiting(number: number): Promise<PullInfo> {
    const info = await this.sessionPull(number)
    if (info.state !== 'open') throw new GitHubError(`Diese ${this.options.submission} ist nicht mehr offen.`, 409)
    if (info.draft) throw new GitHubError(`Diese ${this.options.submission} ist noch ein Entwurf und nicht eingereicht.`, 409)
    return info
  }

  /**
   * Accepts a submission: its pull request is merged into the base branch as one commit. `head` is the commit the
   * person looked at: if the session changed since, nothing is merged (409).
   */
  async merge(number: number, head?: string): Promise<Pull> {
    await this.waiting(number)
    // A submission changes entries and nothing else. A branch that was pushed to by hand may carry more (a workflow, say): that is not accepted here.
    const { files } = await this.pullFiles(number)
    if (files.some((file) => !this.options.isEntryFile(file.filename))) {
      throw new GitHubError(`Diese ${this.options.submission} ändert auch Dateien, die keine ${this.options.entries} sind. Sie wird hier nicht übernommen, bitte auf GitHub prüfen.`, 409)
    }
    try {
      await this.call('PUT', `/pulls/${number}/merge`, { merge_method: 'squash', ...(head ? { sha: head } : {}) })
    } catch (error) {
      // 405: not mergeable (checks, conflicts, rules); 409: the head moved.
      if (error instanceof GitHubError && (error.status === 405 || error.status === 409)) throw new GitHubError(error.message, 409)
      throw error
    }
    return this.pull(number)
  }

  /** Closes a submission without merging it (it can be opened again on GitHub). */
  async reject(number: number): Promise<Pull> {
    await this.waiting(number)
    await this.call('PATCH', `/pulls/${number}`, { state: 'closed' })
    return this.pull(number)
  }

  /** The comments on a submission: those on the pull request itself, and those on files in it (made on GitHub). */
  async comments(number: number): Promise<{ issue: RawComment[]; review: RawComment[] }> {
    const all = async (path: string): Promise<RawComment[]> => {
      const found: RawComment[] = []
      for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
        const batch = await this.call<RawComment[]>('GET', `${path}?per_page=100&page=${page}`)
        found.push(...batch)
        if (batch.length < 100) break
      }
      return found
    }
    await this.sessionPull(number)
    return { issue: await all(`/issues/${number}/comments`), review: await all(`/pulls/${number}/comments`) }
  }

  /** Writes a comment on the pull request of a submission (as the person whose token this is). */
  async addComment(number: number, body: string): Promise<RawComment> {
    await this.sessionPull(number)
    return this.call<RawComment>('POST', `/issues/${number}/comments`, { body })
  }

  /** The comment (of the pull request of a submission) with this id: it is only handled if it is one on a submission. */
  async issueComment(id: number): Promise<RawComment> {
    const comment = await this.call<RawComment>('GET', `/issues/comments/${id}`)
    const number = Number(/\/issues\/(\d+)$/.exec(comment.issue_url ?? '')?.[1])
    if (!Number.isInteger(number)) throw new GitHubError(`Das ist kein Kommentar zu einer ${this.options.submission}.`, 404)
    await this.sessionPull(number)
    return comment
  }

  /** The comment of this person: changing or removing the comment of somebody else is refused here, though GitHub would allow it for everybody with write access. */
  private async ownComment(id: number, login: string): Promise<RawComment> {
    const comment = await this.issueComment(id)
    if ((comment.user?.login ?? '').toLowerCase() !== login.toLowerCase()) throw new GitHubError('Das darf nur, wer den Kommentar geschrieben hat.', 403)
    return comment
  }

  /** Changes the text of a comment of `login`. */
  async editComment(id: number, body: string, login: string): Promise<RawComment> {
    await this.ownComment(id, login)
    return this.call<RawComment>('PATCH', `/issues/comments/${id}`, { body })
  }

  async deleteComment(id: number, login: string): Promise<void> {
    await this.ownComment(id, login)
    await this.call('DELETE', `/issues/comments/${id}`)
  }

  /** How the checks of a commit stand. Unknown if GitHub does not tell (the app may lack the permission to read checks). */
  async checks(commit: string): Promise<Checks> {
    try {
      const runs = await this.call<{ check_runs: { status: string; conclusion: string | null }[] }>('GET', `/commits/${commit}/check-runs?per_page=100`)
      const status = await this.call<{ state: string; total_count: number }>('GET', `/commits/${commit}/status`)
      const states: Checks[] = runs.check_runs.map((run) =>
        run.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(run.conclusion ?? '') ? 'success' : 'failure',
      )
      if (status.total_count > 0) states.push(status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failure')
      if (states.length === 0) return 'none'
      return states.includes('failure') ? 'failure' : states.includes('pending') ? 'pending' : 'success'
    } catch (error) {
      if (error instanceof GitHubError && error.status !== 401) return 'unknown'
      throw error
    }
  }

  /** The newest commit of the base branch and everything in it, with the hash of each file (the caller picks the object files). */
  async tree(): Promise<{ head: string; files: { path: string; sha: string }[] }> {
    const head = await this.head(this.base)
    if (!head) throw new GitHubError(`The branch ${this.base} does not exist.`, 404)
    const commit = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${head}`)
    const tree = await this.call<{ tree: { path: string; type: string; sha: string }[]; truncated?: boolean }>('GET', `/git/trees/${commit.tree.sha}?recursive=1`)
    if (tree.truncated) throw new GitHubError('The repository is too large to be listed at once.', 502)
    return { head, files: tree.tree.filter((entry) => entry.type === 'blob').map((entry) => ({ path: entry.path, sha: entry.sha })) }
  }

  /**
   * What changed on the base branch since a commit: its newest commit and the files that differ. Returns null if
   * that cannot be told (the commit is not known, the branch was rewritten, or there are too many changes): then
   * the caller has to read everything again.
   */
  async changes(since: string): Promise<{ head: string; files: ChangedFile[] } | null> {
    const head = await this.head(this.base)
    if (!head) throw new GitHubError(`The branch ${this.base} does not exist.`, 404)
    if (head === since) return { head, files: [] }
    const files: ChangedFile[] = []
    for (let page = 1; page <= MAX_CHANGE_PAGES; page++) {
      let data: { status: string; files?: ChangedFile[] }
      try {
        data = await this.call('GET', `/compare/${since}...${head}?per_page=100&page=${page}`)
      } catch (error) {
        if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) return null
        throw error
      }
      // "behind" or "diverged": the branch no longer continues from that commit.
      if (data.status !== 'ahead' && data.status !== 'identical') return null
      const batch = data.files ?? []
      files.push(...batch)
      if (batch.length < 100) return { head, files }
    }
    return null // GitHub lists at most 300 files: more than that is read anew
  }

  async pull(number: number): Promise<Pull> {
    const data = await this.call<{ number: number; html_url: string; state: 'open' | 'closed'; merged: boolean; draft?: boolean }>('GET', `/pulls/${number}`)
    return { number: data.number, url: data.html_url, state: data.state, merged: data.merged, draft: data.draft === true }
  }
}
