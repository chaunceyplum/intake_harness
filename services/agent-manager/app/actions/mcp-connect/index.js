/**
 * "Sign in" for an upstream MCP server.
 *
 * Three routes, one round-trip:
 *
 *   GET /mcp-connect/probe?id=<server>   what this server needs, without starting anything
 *   GET /mcp-connect/start?id=<server>   discover + register + redirect to the provider
 *   GET /mcp-connect/callback?code&state exchange the code, store the token, close the window
 *
 * The person clicks Sign in, the provider's own login page opens, and the token
 * comes back here. Nobody mints a service token in a developer console, nobody
 * pastes a secret into a form, and the token belongs to the person who signed
 * in rather than to whoever happened to provision it.
 *
 * WHY START IS A REDIRECT AND NOT JSON
 *
 * The browser has to end up on the provider's domain, and only a top-level
 * navigation can do that safely - an XHR would be blocked, and opening a URL
 * the page constructed itself means trusting the page with the state parameter.
 * The state is created here, stored server-side with its verifier, and consumed
 * here once. The page never sees it.
 *
 * WHAT IS CHECKED
 *
 * `state` is single-use (takeOAuthTransaction deletes on read), so a replayed
 * callback finds nothing and is refused. The verifier never leaves the server.
 * The access token is written to the server's registry entry and is never
 * returned to the browser - mcp-servers.listSafe reports only WHETHER there is
 * one.
 */

const { Core } = require('@adobe/aio-sdk')
const store = require('../../lib/store')
const settings = require('../../lib/settings')
const mcpServers = require('../../lib/mcp-servers')
const mcpOAuth = require('../../lib/mcp-oauth')

let logger

/** Ten minutes is longer than any honest login and shorter than a forgotten tab. */
const TXN_TTL_MS = 10 * 60 * 1000

function html (statusCode, title, message, tone = 'ok') {
    const colour = tone === 'ok' ? '#437543' : '#A34E35'
    return {
        statusCode,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body: `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
 body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;background:#FAF9F5;color:#1F1E1C;
      display:grid;place-items:center;height:100vh;margin:0;padding:24px;text-align:center}
 .card{max-width:520px;background:#fff;border:1px solid #E7E4DB;border-radius:13px;padding:28px 30px;
       box-shadow:0 4px 12px rgba(31,30,28,.08)}
 h1{font-size:19px;margin:0 0 10px;color:${colour}}
 p{margin:0 0 6px;color:#57534B}
 code{background:#F5F4EE;padding:2px 6px;border-radius:6px;font-size:13px}
</style>
<div class="card"><h1>${title}</h1><p>${message}</p>
<p style="margin-top:14px"><small>You can close this window.</small></p></div>
<script>try{ if (window.opener) { window.opener.postMessage({ type: 'mcp-connect', ok: ${tone === 'ok'} }, '*'); setTimeout(() => window.close(), 1200) } }catch(e){}</script>`
    }
}

function json (statusCode, body) {
    return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body }
}

function query (params) {
    const q = params.__ow_query
    if (typeof q === 'string') return new URLSearchParams(q)
    const out = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
        if (!k.startsWith('__ow_') && typeof v === 'string') out.set(k, v)
    }
    return out
}

/**
 * Where the provider sends the person back to.
 *
 * It has to be an absolute URL the provider will accept, and it has to be the
 * SAME string at registration, at /authorize and at /token - providers compare
 * it literally, and a trailing slash difference is the classic silent failure.
 * So it is derived once, here.
 */
function redirectUri (params) {
    // An explicit setting always wins - behind a proxy or a custom domain it is
    // the only thing that can be right.
    const explicit = params.MCP_CONNECT_REDIRECT_URI
    if (explicit) return explicit

    /*
     * Otherwise: the address THE BROWSER ACTUALLY USED.
     *
     * This used to derive from MCP_RESOURCE_URL, which inside a container is the
     * container's own address - http://127.0.0.1:8080/mcp. So the provider sent
     * the person back to port 8080, which nothing is listening on from their
     * machine, and a sign-in that had completely succeeded ended on "not found".
     * The token was never collected.
     *
     * The Host header is what the browser asked for, so it is what the browser
     * can be sent back to. Port mappings, 3000-vs-8080, localhost-vs-127.0.0.1:
     * all of it comes out right without being configured.
     */
    const headers = params.__ow_headers || {}
    const host = headers['x-forwarded-host'] || headers.host
    if (host) {
        const forwarded = headers['x-forwarded-proto']
        const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(String(host))
        const proto = forwarded || (local ? 'http' : 'https')
        return `${proto}://${host}/mcp-connect/callback`
    }

    const base = String(params.MCP_RESOURCE_URL || '').replace(/\/mcp\/?$/, '').replace(/\/+$/, '')
    return base ? `${base}/mcp-connect/callback` : 'http://127.0.0.1:8080/mcp-connect/callback'
}

/** Persist the token onto the server's registry entry, without touching anything else. */
async function storeToken (serverId, token, extra) {
    const overrides = settings.mcpServers()
    const existing = overrides.find(s => s.id === serverId) || { id: serverId }
    const merged = {
        ...existing,
        auth: token.access_token,
        active: true,
        oauth: {
            ...(existing.oauth || {}),
            ...extra,
            refresh_token: token.refresh_token || (existing.oauth || {}).refresh_token || null,
            // Recorded so the UI can say "expires in 2h" rather than discovering
            // it by failing a call.
            expires_at: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
            connected_at: new Date().toISOString()
        }
    }
    const next = overrides.filter(s => s.id !== serverId).concat([merged])
    const current = await store.getSettingsOverride()
    const stored = await store.saveSettingsOverride({ ...current, mcp_servers: next })
    settings._setCache(stored)
}

async function main (params) {
  /*
   * Runtime passes configuration as PARAMETERS; this code reads process.env.
   * Bridge them before anything else runs - lib/storage, lib/auth and the MCP
   * gateway all read the environment at first use, and on this host that was
   * empty. See lib/params-env.js.
   */
  require('../../lib/params-env').applyParams(params)
    logger = Core.Logger('cx-agent-manager-mcp-connect', { level: params.LOG_LEVEL || 'info' })
    const path = String(params.__ow_path || '').replace(/^\/+/, '')
    const q = query(params)

    try {
        await settings.refresh()

        if (path === 'probe') {
            const server = mcpServers.get(q.get('id'), settings.mcpServers())
            if (!server) return json(404, { error: `No MCP server registered with id '${q.get('id')}'` })
            if (!server.endpoint) return json(400, { error: 'That server has no endpoint set yet.' })
            const d = await mcpOAuth.discover(server.endpoint)
            return json(200, {
                id: server.id,
                resource: d.resource,
                authorization_endpoint: d.as.authorization_endpoint,
                supports_registration: !!d.as.registration_endpoint,
                scopes: d.scopes,
                redirect_uri: redirectUri(params)
            })
        }

        if (path === 'start') {
            const id = q.get('id')
            const server = mcpServers.get(id, settings.mcpServers())
            if (!server) return html(404, 'Unknown server', `No MCP server is registered with id <code>${id}</code>.`, 'err')
            if (!server.endpoint) return html(400, 'No endpoint', 'Set this server&rsquo;s endpoint before signing in.', 'err')

            const uri = redirectUri(params)
            const d = await mcpOAuth.discover(server.endpoint)

            // A client id we were given by hand wins; otherwise register one.
            const clientId = server.oauth_client_id || (server.oauth && server.oauth.client_id) ||
                await mcpOAuth.register(d.as, uri)
            /*
             * A STATIC client from the provider's console, which is the only
             * way anyone but the person at this machine can sign in.
             *
             * Adobe IMS registers LOOPBACK redirects only - every other shape,
             * including a clean https hostname, is refused "Invalid redirect
             * URI" - so dynamic registration can never serve a hosted
             * callback. A Developer Console credential can, and Adobe issues
             * those with a secret.
             *
             * Server-side config only. It is never logged and never reaches a
             * client.
             */
            const clientSecret = server.oauth_client_secret ||
                (server.oauth && server.oauth.client_secret) || null

            const verifier = mcpOAuth.randomVerifier()
            const state = mcpOAuth.randomState()
            await store.saveOAuthTransaction(state, {
                serverId: id,
                clientId,
                verifier,
                as: d.as,
                resource: d.resource,
                redirectUri: uri,
                clientSecret,
                expiresAt: Date.now() + TXN_TTL_MS
            })

            const url = mcpOAuth.authorizeUrl({
                as: d.as,
                clientId,
                redirectUri: uri,
                state,
                challenge: mcpOAuth.challengeFor(verifier),
                // Ask only for what the resource says it understands. A scope the
                // provider does not recognise fails the whole authorization.
                scopes: d.scopes,
                resource: d.resource
            })
            logger.info(`mcp-connect: starting OAuth for ${id} at ${d.as.authorization_endpoint}`)
            return { statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store' }, body: '' }
        }

        if (path === 'callback') {
            const err = q.get('error')
            if (err) {
                return html(400, 'Sign-in refused', `The provider returned <code>${err}</code>${q.get('error_description') ? `: ${q.get('error_description')}` : ''}.`, 'err')
            }
            const state = q.get('state')
            const code = q.get('code')
            if (!state || !code) return html(400, 'Incomplete callback', 'The provider did not return a code and state.', 'err')

            // Single use: a replayed callback finds nothing here.
            const txn = await store.takeOAuthTransaction(state)
            if (!txn) return html(400, 'Expired or already used', 'Start the sign-in again from Settings.', 'err')
            if (txn.expiresAt && Date.now() > txn.expiresAt) {
                return html(400, 'Expired', 'That sign-in took too long. Start it again from Settings.', 'err')
            }

            const token = await mcpOAuth.exchange({
                as: txn.as,
                clientId: txn.clientId,
                code,
                verifier: txn.verifier,
                redirectUri: txn.redirectUri,
                resource: txn.resource,
                clientSecret: txn.clientSecret || null
            })
            await storeToken(txn.serverId, token, { client_id: txn.clientId, as: txn.as, resource: txn.resource })
            logger.info(`mcp-connect: stored a token for ${txn.serverId}`)
            return html(200, 'Connected', `<b>${txn.serverId}</b> is signed in and switched on. Its tools are available to Agent Manager now.`)
        }

        return json(404, { error: `Unknown route '${path}'` })
    } catch (e) {
        logger?.error(`mcp-connect ${path} failed: ${e.message}`)
        if (path === 'probe') return json(502, { error: e.message })
        return html(502, 'Could not sign in', e.message, 'err')
    }
}

exports.main = main
// Exported for tests. The redirect URI must be identical at registration,
// /authorize and /token, so how it is derived is worth pinning down.
exports._redirectUri = redirectUri
