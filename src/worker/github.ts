// What the Worker asks of GitHub: sign a person in, find out what they may do in the data repository,
// read the entries, save them to a branch. Everything runs with the person's own token (a GitHub
// App user access token), so commits and pull requests are theirs and GitHub's own rules (branch
// protection, who is a collaborator) apply.

export interface GithubEnv {
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** owner/name of the data repository. */
  DATA_REPO?: string
  /** The branch pull requests go to. */
  BASE_BRANCH?: string
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export interface Tokens {
  access: string
  accessExpires: number
  refresh?: string
  refreshExpires?: number
}

export interface GitHubUser {
  login: string
  name: string
  avatar: string
}

const API = 'https://api.github.com'
const USER_AGENT = 'editors-core'
const TEN_YEARS = 10 * 365 * 24 * 3600 * 1000

async function tokenRequest(env: GithubEnv, params: Record<string, string>, fetchFn: typeof fetch): Promise<Tokens> {
  const response = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok || typeof data.access_token !== 'string') {
    // GitHub answers 200 with an "error" field for a bad code or token.
    throw new GitHubError(String(data.error_description ?? data.error ?? `GitHub answered ${response.status}`), response.ok ? 401 : response.status)
  }
  const now = Date.now()
  return {
    access: data.access_token,
    accessExpires: now + (typeof data.expires_in === 'number' ? data.expires_in * 1000 : TEN_YEARS),
    refresh: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    refreshExpires: typeof data.refresh_token_expires_in === 'number' ? now + data.refresh_token_expires_in * 1000 : undefined,
  }
}

export const exchangeCode = (env: GithubEnv, code: string, verifier: string, redirectUri: string, fetchFn: typeof fetch) =>
  tokenRequest(env, { code, code_verifier: verifier, redirect_uri: redirectUri }, fetchFn)

/** A refresh token can be used once; the answer holds the next one. */
export const refreshTokens = (env: GithubEnv, refresh: string, fetchFn: typeof fetch) =>
  tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refresh }, fetchFn)

/** Takes the token back at GitHub when someone signs out (best effort). */
export async function revoke(env: GithubEnv, token: string, fetchFn: typeof fetch): Promise<void> {
  try {
    await fetchFn(`${API}/applications/${env.GITHUB_CLIENT_ID}/token`, {
      method: 'DELETE',
      headers: {
        authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ access_token: token }),
    })
  } catch {
    // The cookie is gone either way.
  }
}

export async function call<T>(fetchFn: typeof fetch, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetchFn(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string }
    throw new GitHubError(detail.message ?? `GitHub answered ${response.status}`, response.status)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export async function currentUser(token: string, fetchFn: typeof fetch): Promise<GitHubUser> {
  const user = await call<{ login: string; name: string | null; avatar_url: string }>(fetchFn, token, 'GET', '/user')
  return { login: user.login, name: user.name || user.login, avatar: user.avatar_url }
}

/** What the person may do in the data repository: `admin` (maintain/admin), `write`, or `none`. */
export async function repoRole(token: string, repo: string, fetchFn: typeof fetch): Promise<'admin' | 'write' | 'none'> {
  const data = await call<{ permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } }>(fetchFn, token, 'GET', `/repos/${repo}`)
  if (data.permissions?.admin || data.permissions?.maintain) return 'admin'
  return data.permissions?.push ? 'write' : 'none'
}
