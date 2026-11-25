// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SIGN_LINK_HEADER, sessionCookieName, sessionFor, sessionForToken } from './portal'

const request = (headers: Record<string, string>) => new Request('https://sign.example/api/portal/envelope', { headers })

describe('signer sessions from cookies', () => {
  it('finds the session of one link among others', async () => {
    const name = await sessionCookieName('token-a')
    const other = await sessionCookieName('token-b')
    const cookies = `${other}=b-session; ${name}=a%20session; theme=dark`
    expect(await sessionForToken(request({ cookie: cookies }), 'token-a')).toBe('a session')
    expect(await sessionForToken(request({ cookie: cookies }), 'token-c')).toBeUndefined()
    expect(await sessionForToken(request({}), 'token-a')).toBeUndefined()
  })

  it('takes the link from the header the page sends', async () => {
    const name = await sessionCookieName('token-a')
    expect(await sessionFor(request({ [SIGN_LINK_HEADER]: 'token-a', cookie: `${name}=s1` }))).toBe('s1')
    expect(await sessionFor(request({ cookie: `${name}=s1` }))).toBeUndefined()
  })

  it('gives each link its own cookie name', async () => {
    expect(await sessionCookieName('token-a')).not.toBe(await sessionCookieName('token-b'))
    expect(await sessionCookieName('token-a')).toMatch(/^signportal_session_[0-9a-f]{16}$/)
  })
})
