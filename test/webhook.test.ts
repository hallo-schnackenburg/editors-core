import { describe, expect, it } from 'vitest'
import { createHook, signedBy } from '../src/worker/webhook.js'

const SECRET = 'hook-secret'
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
async function sign(body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))}`
}

describe('the webhook', () => {
  const sent: string[] = []
  const HUB = { idFromName: () => 'hub', get: () => ({ fetch: async (request: Request) => (sent.push(await request.text()), new Response(null, { status: 204 })) }) }
  const env = { WEBHOOK_SECRET: SECRET, DATA_REPO: 'o/r', BASE_BRANCH: 'main', HUB }
  const hook = createHook({ branchPrefix: 'erfassung/' })

  async function call(event: string, payload: object, signature?: string) {
    const body = JSON.stringify({ repository: { full_name: 'o/r' }, ...payload })
    const request = new Request('https://x.test/hook/github', { method: 'POST', body, headers: { 'x-github-event': event, 'x-hub-signature-256': signature ?? (await sign(body)) } })
    sent.length = 0
    return hook(request, '/hook/github', env)
  }

  it('only believes a call that is signed', async () => {
    expect(await signedBy(SECRET, 'x', await sign('x'))).toBe(true)
    expect(await signedBy(SECRET, 'x', await sign('y'))).toBe(false)
    expect(await signedBy(SECRET, 'x', null)).toBe(false)
    expect((await call('push', { ref: 'refs/heads/main', after: 'abc' }, 'sha256=00'))!.status).toBe(401)
    expect(sent).toEqual([])
  })

  it('tells about the base branch, and about the branches that start with its prefix', async () => {
    expect((await call('push', { ref: 'refs/heads/main', after: 'abc' }))!.status).toBe(204)
    expect(JSON.parse(sent[0])).toEqual({ type: 'push', ref: 'refs/heads/main', head: 'abc' })
    await call('push', { ref: 'refs/heads/erfassung/anna/fest', after: 'def' })
    expect(JSON.parse(sent[0])).toEqual({ type: 'pull', branch: 'erfassung/anna/fest', head: 'def' })
    await call('pull_request', { number: 3, pull_request: { head: { ref: 'erfassung/anna/fest', sha: 'f00' } } })
    expect(JSON.parse(sent[0])).toEqual({ type: 'pull', number: 3, branch: 'erfassung/anna/fest', head: 'f00' })
    await call('issue_comment', { issue: { number: 3, pull_request: {} } })
    expect(JSON.parse(sent[0])).toEqual({ type: 'comment', number: 3 })
  })

  it('does not tell about other branches, other repositories or other routes', async () => {
    expect((await call('push', { ref: 'refs/heads/submission/anna/fest', after: 'def' }))!.status).toBe(202)
    expect((await call('push', { repository: { full_name: 'x/y' }, ref: 'refs/heads/main', after: 'a' }))!.status).toBe(202)
    expect(sent).toEqual([])
    expect(await hook(new Request('https://x.test/other', { method: 'POST' }), '/other', env)).toBeNull()
  })
})
