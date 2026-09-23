/**
 * A static OAuth client, which is the only way anybody but the person at this
 * machine can sign in.
 *
 * Tested against Adobe IMS on 21 Sep 2026: its dynamic client registration
 * accepts LOOPBACK redirects and nothing else. `http://127.0.0.1:8080/...` and
 * `http://localhost:53682/...` both registered; a public IP over http, the
 * same over https, and two clean https HOSTNAMES were all refused
 * "Invalid redirect URI". Its metadata also advertises no `client_credentials`
 * grant, so there is no headless option either.
 *
 * So a hosted callback needs a client created in the provider's own console,
 * and those come with a secret. `mcp-oauth.js` sent none - it was written for
 * the dynamically registered public client, which has none - so the first
 * sign-in with a real Developer Console credential would have failed on the
 * token exchange.
 *
 * And it would have failed in a specific, already-known way. oauth-bridge
 * records it as D78: IMS wants the secret as a FORM PARAM, rejects the Basic
 * header, and reports the rejection as `invalid_grant` rather than the
 * RFC-conventional `invalid_client`. These tests pin that behaviour so the
 * lesson is not paid for twice.
 */

const mcpOAuth = require('../lib/mcp-oauth')

const AS = { token_endpoint: 'https://ims-na1.adobelogin.com/ims/token/v3' }

/** Every request the code made, so the auth STYLE can be asserted. */
let calls

/**
 * @param {(call: object, n: number) => object} responder
 */
function mockToken (responder) {
    calls = []
    global.fetch = jest.fn(async (url, init) => {
        const form = new URLSearchParams(init.body)
        const call = {
            url,
            authorization: init.headers.Authorization || null,
            params: Object.fromEntries(form.entries())
        }
        calls.push(call)
        const { status, body } = responder(call, calls.length)
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify(body)
        }
    })
}

afterEach(() => { delete global.fetch })

const ok = () => ({ status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } })

describe('a public client is unchanged', () => {
    test('no secret is sent, and no Authorization header', async () => {
        mockToken(ok)
        await mcpOAuth.exchange({
            as: AS, clientId: 'public-id', code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:8080/cb'
        })
        expect(calls).toHaveLength(1)
        expect(calls[0].params.client_secret).toBeUndefined()
        expect(calls[0].authorization).toBeNull()
        // PKCE is what authenticates a public client, so it must still go.
        expect(calls[0].params.code_verifier).toBe('v')
    })
})

describe('a confidential client sends the secret the way IMS wants it', () => {
    test('FORM PARAM on the first attempt, never a Basic header', async () => {
        // The empirical finding, and the whole point: with Basic, IMS answers
        // "missing client_secret parameter".
        mockToken(ok)
        await mcpOAuth.exchange({
            as: AS, clientId: 'id', code: 'c', verifier: 'v',
            redirectUri: 'https://am.example.com/mcp-connect/callback', clientSecret: 's3cret'
        })
        expect(calls).toHaveLength(1)
        expect(calls[0].params.client_secret).toBe('s3cret')
        expect(calls[0].authorization).toBeNull()
    })

    test('the refresh carries it too', async () => {
        // A client that can sign in and then never refresh looks like a token
        // that expires for no reason a day later.
        mockToken(ok)
        await mcpOAuth.refresh({ as: AS, clientId: 'id', refreshToken: 'rt', clientSecret: 's3cret' })
        expect(calls[0].params.grant_type).toBe('refresh_token')
        expect(calls[0].params.client_secret).toBe('s3cret')
    })

    test('resource indicator survives alongside the secret', async () => {
        mockToken(ok)
        await mcpOAuth.exchange({
            as: AS, clientId: 'id', code: 'c', verifier: 'v', redirectUri: 'x',
            resource: 'https://rtcdp-mcp.adobe.io/mcp', clientSecret: 's'
        })
        expect(calls[0].params.resource).toBe('https://rtcdp-mcp.adobe.io/mcp')
    })
})

describe('the Basic fallback, for a provider that needs it', () => {
    test('retries with Basic when the first attempt rejects the client auth STYLE', async () => {
        mockToken((call, n) => n === 1
            ? { status: 400, body: { error: 'invalid_client', error_description: 'client authentication failed' } }
            : ok())
        const token = await mcpOAuth.exchange({
            as: AS, clientId: 'id', code: 'c', verifier: 'v', redirectUri: 'x', clientSecret: 's'
        })
        expect(token.access_token).toBe('at')
        expect(calls).toHaveLength(2)
        expect(calls[0].params.client_secret).toBe('s')
        expect(calls[1].authorization).toMatch(/^Basic /)
        // RFC 6749 forbids both styles at once.
        expect(calls[1].params.client_secret).toBeUndefined()
    })

    test('retries when IMS calls it invalid_grant - the D78 bug', () => {
        /*
         * This is the assertion that matters most in this file. IMS reports a
         * missing or unacceptable client_secret as `invalid_grant`, so a retry
         * keyed on `invalid_client` alone never fires and the sign-in dies on
         * a completely fixable error. That exact bug already shipped once.
         */
        mockToken((call, n) => n === 1
            ? { status: 400, body: { error: 'invalid_grant', error_description: 'missing client_secret parameter' } }
            : ok())
        return mcpOAuth.exchange({
            as: AS, clientId: 'id', code: 'c', verifier: 'v', redirectUri: 'x', clientSecret: 's'
        }).then((token) => {
            expect(token.access_token).toBe('at')
            expect(calls).toHaveLength(2)
            expect(calls[1].authorization).toMatch(/^Basic /)
        })
    })

    test('a PLAIN grant failure is NOT retried - the code is single use', async () => {
        // Replaying a consumed authorization code turns a clear error into a
        // confusing one, so only a client-auth rejection earns a second go.
        mockToken(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'code expired' } }))
        await expect(mcpOAuth.exchange({
            as: AS, clientId: 'id', code: 'c', verifier: 'v', redirectUri: 'x', clientSecret: 's'
        })).rejects.toThrow(/Token exchange failed/)
        expect(calls).toHaveLength(1)
    })

    test('a public client never retries, because there is nothing to retry with', async () => {
        mockToken(() => ({ status: 400, body: { error: 'invalid_client' } }))
        await expect(mcpOAuth.exchange({
            as: AS, clientId: 'id', code: 'c', verifier: 'v', redirectUri: 'x'
        })).rejects.toThrow(/Token exchange failed/)
        expect(calls).toHaveLength(1)
    })
})

describe('the secret does not leak', () => {
    test('it is never in the error text of a failed exchange', async () => {
        mockToken(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'code expired' } }))
        const err = await mcpOAuth.exchange({
            as: AS, clientId: 'id', code: 'c', verifier: 'v', redirectUri: 'x', clientSecret: 'TOPSECRET'
        }).catch((e) => e)
        expect(String(err.message)).not.toContain('TOPSECRET')
    })
})
