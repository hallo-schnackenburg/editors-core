import { describe, expect, it } from 'vitest'
import { readCookie, seal, setCookie, unseal } from '../src/worker/session.js'

describe('the session cookie', () => {
  it('keeps what is put in, and only for the secret it was made with', async () => {
    const sealed = await seal({ login: 'anna' }, 'secret')
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await unseal(sealed, 'secret')).toEqual({ login: 'anna' })
    expect(await unseal(sealed, 'other')).toBeNull()
    expect(await unseal('garbage', 'secret')).toBeNull()
  })

  it('reads a cookie by its name, and writes one that scripts cannot see', () => {
    const request = new Request('https://x.test/', { headers: { cookie: 'a=1; editor_session=abc=; b=2' } })
    expect(readCookie(request, 'editor_session')).toBe('abc=')
    expect(readCookie(request, 'missing')).toBeUndefined()
    expect(setCookie('n', 'v', 60, true)).toBe('n=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure')
    expect(setCookie('n', 'v', 60, false)).not.toContain('Secure')
  })
})
