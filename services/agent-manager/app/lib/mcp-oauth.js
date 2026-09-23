/**
 * Signing in to an upstream MCP server, as a client.
 *
 * WHY THIS EXISTS
 *
 * Connecting an official Adobe MCP used to mean: go to the Developer Console,
 * mint a service token, put it in the environment as WORKFRONT_TOKEN, redeploy,
 * come back and flip `active`. Four steps, three of them outside this product,
 * and the token belongs to whoever minted it rather than to the person using
 * it. The registry field said `${WORKFRONT_TOKEN}` and, predictably, it was
 * never set.
 *
 * The MCP spec already solves this. A protected server answers an unauthorised
 * call with `WWW-Authenticate: Bearer resource_metadata="..."` (RFC 9728),
 * which leads to its authorization server, which advertises Dynamic Client
 * Registration (RFC 7591). So the whole chain needs NO pre-provisioned
 * credential: discover, register ourselves, send the person to the provider's
 * own login page, take the code back. Verified against
 * mcp.workfront.adobe.com, which advertises exactly this - PKCE S256, refresh
 * tokens, registration_endpoint, and `none` for client auth.
 *
 * NOTHING HERE IS WORKFRONT-SPECIFIC. Every endpoint is discovered. That is the
 * point: the next Adobe MCP is a URL in Settings, not a code change.
 *
 * WHAT IS DELIBERATELY NOT DONE
 *
 * No client secret is stored, because we register as a public client and use
 * PKCE - a secret in this store would be a liability that buys nothing. The
 * access token IS stored, because it has to be; it is never returned to the
 * browser (see mcp-servers.listSafe) and never logged.
 */

const crypto = require('crypto')

const TIMEOUT_MS = 20000

function base64url (buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomVerifier () { return base64url(crypto.randomBytes(48)) }
function challengeFor (verifier) { return base64url(crypto.createHash('sha256').update(verifier).digest()) }
function randomState () { return base64url(crypto.randomBytes(24)) }

async function fetchJson (url, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
        const res = await fetch(url, { ...options, signal: controller.signal })
        const text = await res.text()
        let body = null
        try { body = JSON.parse(text) } catch (e) { /* handled by the caller */ }
        return { ok: res.ok, status: res.status, headers: res.headers, body, text }
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Where a protected MCP server says its metadata lives.
 *
 * Asked the way the spec intends - make an unauthorised call and read the
 * challenge - with the conventional well-known path as a fallback, because a
 * server that is merely unconfigured rather than protected will not send the
 * header at all.
 */
async function resourceMetadataUrl (endpoint) {
    const probe = await fetchJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    }).catch(() => null)

    const challenge = probe && probe.headers && probe.headers.get('www-authenticate')
    const named = challenge && /resource_metadata="([^"]+)"/i.exec(challenge)
    if (named) return named[1]

    const base = String(endpoint).replace(/\/+$/, '')
    return `${base}/.well-known/oauth-protected-resource`
}

/**
 * Follow the chain: MCP endpoint -> protected-resource metadata -> authorization
 * server metadata.
 *
 * The AS metadata path is tried both ways round. RFC 8414 inserts the well-known
 * segment after the origin and keeps the path suffix; plenty of deployments
 * simply append it. Trying only one of the two is the most common reason this
 * kind of discovery "mysteriously" fails.
 *
 * @param {string} endpoint the MCP server URL
 * @returns {Promise<{resource: string, scopes: string[], as: object}>}
 */
async function discover (endpoint) {
    const prmUrl = await resourceMetadataUrl(endpoint)
    const prm = await fetchJson(prmUrl)
    if (!prm.ok || !prm.body) {
        throw new Error(`No OAuth metadata at ${prmUrl} (HTTP ${prm.status}). This server may not use OAuth - set an Authorization value instead.`)
    }

    const issuer = (prm.body.authorization_servers || [])[0]
    if (!issuer) throw new Error(`${prmUrl} lists no authorization_servers.`)

    const u = new URL(issuer)
    const suffix = u.pathname.replace(/\/+$/, '')
    const candidates = [
        `${u.origin}/.well-known/oauth-authorization-server${suffix}`,
        `${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`,
        `${u.origin}/.well-known/openid-configuration${suffix}`,
        `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
    ]

    const tried = []
    for (const url of candidates) {
        const res = await fetchJson(url).catch(() => null)
        if (res && res.ok && res.body && res.body.authorization_endpoint) {
            return {
                resource: prm.body.resource || endpoint,
                scopes: prm.body.scopes_supported || [],
                as: res.body
            }
        }
        tried.push(`${url} (${res ? res.status : 'unreachable'})`)
    }
    throw new Error(`Found the authorization server "${issuer}" but none of its metadata URLs answered: ${tried.join(', ')}`)
}

/**
 * Register ourselves with the provider (RFC 7591).
 *
 * A public client: no secret, PKCE instead. Providers that do not offer
 * registration need a client id configured by hand, and say so rather than
 * failing halfway through a browser redirect.
 */
async function register (as, redirectUri, clientName = 'CX Agent Manager') {
    if (!as.registration_endpoint) {
        throw new Error('This provider does not support dynamic client registration. Register a client with them and set its id on the server entry as oauth_client_id.')
    }
    const res = await fetchJson(as.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: clientName,
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            application_type: 'web'
        })
    })
    if (!res.ok || !res.body || !res.body.client_id) {
        throw new Error(`Registration failed at ${as.registration_endpoint} (HTTP ${res.status}): ${res.text ? res.text.slice(0, 200) : 'no body'}`)
    }
    return res.body.client_id
}

/** The URL to send the person to. */
function authorizeUrl ({ as, clientId, redirectUri, state, challenge, scopes, resource }) {
    const url = new URL(as.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (scopes && scopes.length) url.searchParams.set('scope', scopes.join(' '))
    // RFC 8707. The provider advertises resource_indicators_supported, and a
    // token minted without it can come back scoped to the wrong audience.
    if (resource) url.searchParams.set('resource', resource)
    return url.toString()
}

/** @returns {Promise<{access_token, refresh_token?, expires_in?, token_type?}>} */
/**
 * Does this failure look like the provider rejecting the client-authentication
 * STYLE, rather than rejecting the grant itself?
 *
 * Keyed broadly on purpose, and this is the whole lesson of D78: IMS reports a
 * missing or unacceptable client_secret as `invalid_grant`, not the
 * RFC-conventional `invalid_client`, so a narrow check never retries and the
 * sign-in dies on a fixable error.
 */
function looksLikeClientAuthRejection (res) {
    if (res.ok) return false
    if (res.body && res.body.error === 'invalid_client') return true
    const text = `${(res.body && res.body.error_description) || ''} ${res.text || ''}`
    return /client[_\s-]?secret|client authentication|unauthorized[_\s-]?client/i.test(text)
}

/**
 * POST to the token endpoint, carrying the client secret the way the provider
 * wants it.
 *
 * WHICH STYLE, SETTLED EMPIRICALLY (D77/D78, and reused here rather than
 * rediscovered). Adobe's current IMS reference documents an
 * `Authorization: Basic base64(id:secret)` header; its older adobeio-auth doc
 * says Basic is unsupported and to send a `client_secret` form param. A live
 * sign-in settled it - with the Basic header IMS answered "missing
 * client_secret parameter". So FORM IS PRIMARY.
 *
 * Basic is kept as a fallback for a provider that needs it, and is tried only
 * when the first attempt looks like a client-auth rejection. Never on a plain
 * grant failure: an authorization code is single-use, and retrying one that
 * was already consumed turns a clear error into a confusing one. RFC 6749
 * forbids sending both styles at once, hence sequential attempts.
 *
 * A public client - no secret, which is every dynamically registered one -
 * sends neither and behaves exactly as before.
 */
async function postToken (as, params, clientSecret) {
    const attempt = async (style) => {
        const form = new URLSearchParams(params)
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
        if (clientSecret && style === 'form') form.set('client_secret', clientSecret)
        if (clientSecret && style === 'basic') {
            headers.Authorization = `Basic ${Buffer.from(`${params.client_id}:${clientSecret}`).toString('base64')}`
        }
        return fetchJson(as.token_endpoint, { method: 'POST', headers, body: form.toString() })
    }

    const first = await attempt(clientSecret ? 'form' : 'none')
    if (first.ok || !clientSecret || !looksLikeClientAuthRejection(first)) return first
    return attempt('basic')
}

async function exchange ({ as, clientId, code, verifier, redirectUri, resource, clientSecret }) {
    const params = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier
    }
    if (resource) params.resource = resource
    const res = await postToken(as, params, clientSecret)
    if (!res.ok || !res.body || !res.body.access_token) {
        throw new Error(`Token exchange failed (HTTP ${res.status}): ${res.text ? res.text.slice(0, 250) : 'no body'}`)
    }
    return res.body
}

/** Swap a refresh token for a new access token. */
async function refresh ({ as, clientId, refreshToken, resource, clientSecret }) {
    const params = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId
    }
    if (resource) params.resource = resource
    // The same client authentication as the exchange. A confidential client
    // that could sign in and then never refresh would look like a token that
    // expires for no reason a day later.
    const res = await postToken(as, params, clientSecret)
    if (!res.ok || !res.body || !res.body.access_token) {
        throw new Error(`Refresh failed (HTTP ${res.status}): ${res.text ? res.text.slice(0, 250) : 'no body'}`)
    }
    return res.body
}

module.exports = {
    discover, register, authorizeUrl, exchange, refresh,
    randomVerifier, challengeFor, randomState, resourceMetadataUrl
}
