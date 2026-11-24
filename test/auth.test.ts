import { describe, expect, it } from 'vitest'
import { createAuth } from '../src/worker/auth.js'
import { seal } from '../src/worker/session.js'

const env = { GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', SESSION_SECRET: 's3cret', DATA_REPO: 'o/r', APP_URL: 'https://app.test', FILES: 'https://files.test' }
const never = (async () => new Response('no', { status: 500 })) as typeof fetch

describe('signing in', () => {
  const auth = createAuth<typeof env>({ cookiePrefix: 'my_editor', me: (e) => ({ files: e.FILES }) })
  const session = { login: 'anna', name: 'Anna', avatar: '', role: 'write', access: 'tok', accessExpires: Date.now() + 3_600_000 }

  it('knows the person by a cookie that is named after the editor', async () => {
    const cookie = `my_editor_session=${await seal(session, env.SESSION_SECRET)}`
    const me = await auth.handleAuth(new Request('https://x.test/auth/me', { headers: { cookie } }), '/auth/me', env, never)
    expect(me!.status).toBe(200)
    expect(await me!.json()).toEqual({ login: 'anna', name: 'Anna', avatar: '', role: 'write', files: 'https://files.test' })
    // another editor's cookie is not ours
    const other = await auth.handleAuth(new Request('https://x.test/auth/me', { headers: { cookie: cookie.replace('my_editor', 'other_editor') } }), '/auth/me', env, never)
    expect(other!.status).toBe(401)
  })

  it('sends the person to GitHub and keeps state and verifier in a cookie of its own', async () => {
    const response = await auth.handleAuth(new Request('https://x.test/auth/login'), '/auth/login', env, never)
    expect(response!.status).toBe(302)
    expect(response!.headers.get('location')).toContain('https://github.com/login/oauth/authorize')
    expect(response!.headers.get('set-cookie')).toMatch(/^my_editor_login=/)
  })

  it('leaves other routes alone, and says when it is not set up', async () => {
    expect(await auth.handleAuth(new Request('https://x.test/other'), '/other', env, never)).toBeNull()
    const bare = await auth.handleAuth(new Request('https://x.test/auth/me'), '/auth/me', { ...env, SESSION_SECRET: undefined } as never, never)
    expect(bare!.status).toBe(500)
  })
})
