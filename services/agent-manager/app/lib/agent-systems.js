/**
 * Agent systems — the upstreams that actually execute agents.
 *
 * This is the ONLY file that knows how to talk to an executing system. Its
 * shape comes from config/agent-systems.json, so onboarding an agentic AEM or
 * an agentic Campaign later is a config entry, not a code change.
 *
 * Two rules it exists to keep:
 *
 *   1. No agent name appears here. Agents are discovered from the upstream's
 *      own catalog, so that system stays the source of truth for what its
 *      agents are called. A fifth agent appears with nothing changed here.
 *
 *   2. Capture is POLLED, not intercepted. The upstream orchestrator calls its
 *      agents server-side, so we start a run and then read it back. Said
 *      plainly, because claiming interception would be claiming a guarantee we
 *      do not have.
 */

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'agent-systems.json')

let cache = null

/** @returns {{systems: object[]}} the registry, read once */
function registry () {
    if (cache) return cache
    try {
        cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    } catch (e) {
        cache = { systems: [] }
    }
    if (!Array.isArray(cache.systems)) cache.systems = []
    return cache
}

/** Test seam, and used after a registry edit. */
function reset () { cache = null }

/**
 * The shape of an entry, for the Settings form and for validation.
 *
 * Every field here is something an upstream can legitimately differ on, which
 * is the point: a second harness is a row in this form, never a branch in code.
 * The paths and keys are how we read ITS catalog and ITS run envelope, so a
 * system that calls its agents something else, under a different route, is
 * configuration rather than an adapter rewrite.
 */
const FIELDS = [
    { key: 'id', label: 'ID', required: true, hint: 'Stable key, e.g. agentic-harness' },
    { key: 'label', label: 'Name', required: true, hint: 'What people see' },
    { key: 'practice', label: 'Domain', hint: 'workfront | aep | aem' },
    { key: 'base_url', label: 'Base URL', required: true, hint: 'Where the harness answers' },
    { key: 'auth', label: 'Authorization header', secret: true, hint: 'Blank when the host has no auth. An ${ENV_VAR} value is read from the environment.' },
    { key: 'mcp_endpoint', label: 'MCP endpoint it calls', hint: 'Which MCP estate the harness itself reaches' },
    { key: 'mcp_server_id', label: 'Backed by MCP server', hint: 'Which registered MCP server it should use' },
    { key: 'agents_path', label: 'Agent catalog path', hint: 'Where its own agent list lives, e.g. /api/tasks' },
    { key: 'start_path', label: 'Start-run path', hint: 'e.g. /api/runs' },
    { key: 'run_path', label: 'Read-run path', hint: 'e.g. /api/runs/{run_id}' },
    { key: 'gate_path', label: 'Gate-decision path', hint: 'Where an approval is recorded, e.g. /api/runs/{run_id}/gate. Blank if the harness has no gates.' },
    { key: 'resume_path', label: 'Answer-question path', hint: 'Where an answer to a needs_input question goes, e.g. /api/runs/{run_id}/resume.' },
    { key: 'continue_path', label: 'Continue path', hint: 'Where a run is advanced one step, e.g. /api/runs/{run_id}/continue.' },
    { key: 'preview_path', label: 'Preview path', hint: 'Where a brief is previewed without creating anything, e.g. /api/intake/preview.' },
    { key: 'input_key', label: 'Input key', hint: 'The field the brief goes in, e.g. brief' },
    { key: 'input_envelope', label: 'Input envelope', hint: 'Wrapper around the input, e.g. input. Blank for top level.' },
    { key: 'active', label: 'Active', type: 'boolean', hint: 'Off leaves it registered but unused' }
]

/**
 * The seed file merged with whatever an admin changed in Settings, by id.
 *
 * config/agent-systems.json claimed to be "editable from Settings" and was
 * not: there was no override list and no setter, so wiring a second harness
 * meant editing a file inside the image and redeploying.
 * @param {object[]} [overrides] from settings.agentSystems()
 */
function merged (overrides) {
    const byId = new Map(registry().systems.map(s => [s.id, { ...s }]))
    for (const o of Array.isArray(overrides) ? overrides : []) {
        if (!o || !o.id) continue
        byId.set(o.id, { ...(byId.get(o.id) || {}), ...o })
    }
    return [...byId.values()]
}

/** @returns {object[]} every registered system, active or not */
function list (overrides) {
    return merged(overrides).map(s => ({
        id: s.id,
        label: s.label,
        practice: s.practice || null,
        adapter: s.adapter || null,
        active: !!s.active,
        base_url: s.base_url || null,
        mcp_endpoint: s.mcp_endpoint || null,
        mcp_server_id: s.mcp_server_id || null,
        // Enough for a Settings form to round-trip an entry without a second call.
        agents_path: s.agents_path || null,
        start_path: s.start_path || null,
        run_path: s.run_path || null,
        gate_path: s.gate_path || null,
        resume_path: s.resume_path || null,
        continue_path: s.continue_path || null,
        preview_path: s.preview_path || null,
        input_key: s.input_key || null,
        input_envelope: s.input_envelope || null,
        auth_configured: !!s.auth,
        notes: s.notes || []
    }))
}

/** @param {string} id @returns {object|null} the raw entry, with its endpoint config */
function get (id, overrides) {
    return merged(overrides).find(s => s.id === id) || null
}

/**
 * The system to use when the caller did not name one. Exactly one active system
 * is the common case; more than one is ambiguous and says so rather than
 * guessing.
 * @param {string} [practice]
 * @returns {{system: object|null, error: string|null}}
 */
function resolve (id, practice, overrides) {
    if (id) {
        const found = get(id, overrides)
        if (!found) return { system: null, error: `Unknown agent system '${id}'. Known: ${list(overrides).map(s => s.id).join(', ')}` }
        if (!found.active) return { system: null, error: `Agent system '${id}' is registered but not active.` }
        return { system: found, error: null }
    }
    /*
     * merged(), not registry(): the seed FILE is not the answer once an admin
     * has changed something in Settings. This line read the file, so pointing
     * the harness at a different host from Settings appeared to work - the
     * registry showed the new URL - while every run went on being sent to the
     * old one. The override was correct and simply not consulted.
     */
    const active = merged(overrides).filter(s => s.active && (!practice || s.practice === practice))
    if (active.length === 1) return { system: active[0], error: null }
    if (active.length === 0) return { system: null, error: 'No active agent system is registered.' }
    return {
        system: null,
        error: `More than one active agent system (${active.map(s => s.id).join(', ')}). Name one with system_id.`
    }
}

function headers (system) {
    const h = { 'Content-Type': 'application/json' }
    if (system.auth) h.Authorization = system.auth
    return h
}

async function request (url, options, timeoutMs = 30000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(url, { ...options, signal: controller.signal })
        const text = await res.text()
        let body = null
        try { body = text ? JSON.parse(text) : null } catch (e) { body = { raw: text } }
        if (!res.ok) {
            const err = new Error(`${options.method || 'GET'} ${url} returned HTTP ${res.status}`)
            err.status = res.status
            err.body = body
            throw err
        }
        return body
    } finally {
        clearTimeout(timer)
    }
}

/**
 * The upstream's own agent catalog. Never a hardcoded list.
 * @returns {Promise<Array<{id,label,owner}>>}
 */
async function discoverAgents (system) {
    if (!system.base_url || !system.agents_path) return []
    const body = await request(`${system.base_url}${system.agents_path}`, { headers: headers(system) })
    const items = Array.isArray(body) ? body : (body?.[system.agents_key || 'agents'] || [])
    return items.map(i => ({
        id: i[system.agent_id_key || 'id'],
        label: i[system.agent_label_key || 'label'] || i[system.agent_id_key || 'id'],
        owner: i[system.agent_owner_key || 'owner'] || null
    })).filter(a => a.id)
}

/**
 * Start a run upstream.
 * @returns {Promise<{upstream_run_id: string, raw: object}>}
 */
async function startRun (system, input, fields) {
    // Two shapes in the wild: the payload at the top level, or nested under an
    // envelope key. Config decides, so a second system with a different contract
    // needs no code here.
    const inner = { [system.input_key || 'brief']: input }
    /*
     * WHAT THE CALLER ALREADY READ, ALONGSIDE THE WORDS IT READ IT FROM.
     *
     * The harness's intake route has accepted `input.fields` since it was
     * written - `parseBrief(brief, body.input?.fields || {})` - and nothing on
     * this side ever sent any. So the deterministic parser did all the reading
     * alone, and the brief's FORMAT decided the outcome: the same Xfinity brief
     * took ONE round with "Label: value" rows and SEVEN with the tab-separated
     * table the BU actually copies out of Workfront, because no row matched and
     * the questionnaire then asked for everything the table already said.
     *
     * A marketer reaches this through an AI that has read the table. Asking it
     * what it read costs nothing and makes the layout irrelevant. The parser
     * still runs, and still grounds every value against the brief's own words,
     * so a field the brief does not support is caught rather than trusted.
     */
    if (fields && typeof fields === 'object' && Object.keys(fields).length) inner.fields = fields
    const payload = system.input_envelope ? { [system.input_envelope]: inner } : inner
    const body = await request(`${system.base_url}${system.start_path}`, {
        method: 'POST', headers: headers(system), body: JSON.stringify(payload)
    })
    const envelope = body?.run || body
    const runId = envelope?.[system.run_id_key || 'run_id']
    if (!runId) {
        const err = new Error('The upstream accepted the request but returned no run id')
        err.body = body
        throw err
    }
    return { upstream_run_id: String(runId), raw: body }
}

/** @returns {Promise<object>} the upstream's run envelope, verbatim */
async function getRun (system, upstreamRunId) {
    const url = `${system.base_url}${(system.run_path || '/api/runs/{run_id}').replace('{run_id}', encodeURIComponent(upstreamRunId))}`
    return request(url, { headers: headers(system) })
}

/*
 * States that will not change on their own, so polling should stop.
 *
 * 'awaiting_approval' is the one added for the gate at 1.5, and it HAS to be
 * here: a run waiting on a human does not settle in 25 seconds, so leaving it
 * out meant every gated run polled to the timeout and then reported
 * `settled: false` - "the pipeline had not finished when this returned" -
 * which reads as a slow run rather than as a run waiting for you to approve it.
 * The distinction is the entire feature.
 */
const TERMINAL = ['completed', 'failed', 'needs_input', 'awaiting_approval']

/**
 * Poll until the run reaches a terminal state or we run out of patience.
 *
 * Returns whatever it last saw either way, with `settled` false on a timeout -
 * a partial run that says so is more use than an exception.
 */
async function waitForRun (system, upstreamRunId, { timeoutMs = 25000, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    for (;;) {
        last = await getRun(system, upstreamRunId)
        const status = last?.run?.status
        if (TERMINAL.includes(status)) return { envelope: last, settled: true }
        if (Date.now() >= deadline) return { envelope: last, settled: false }
        await new Promise(r => setTimeout(r, intervalMs))
    }
}

/**
 * Find an error embedded anywhere in a payload.
 *
 * The upstream does not raise tool failures - it catches them, writes them into
 * the step's output and still reports `completed`. Anything that trusts the
 * status field records those runs as clean successes. So we go looking.
 *
 * Verified live: intake calls `search_knowledge_base`, which does not exist on
 * the MCP server (the tool is `search_adobe_knowledge`), and the run still
 * reads as completed.
 */
/* ---------------------------------------------------------------------------
 * Finding a failure a stage did not admit to.
 *
 * This is the product. Everything else is presentation.
 *
 * The first version looked for a key called `error`, `err` or `exception`, and
 * on that basis reported zero silent failures on a run where Agent 1 had failed
 * to create the Workfront issue. The failure was shaped like this:
 *
 *   "workfront": { "created": false,
 *                  "reason": "MCP tool ... returned an error: ... not found",
 *                  "wouldHaveCreated": { ... } }
 *
 * No key called error, so nothing was found, so the time ledger printed "No
 * stage contradicted its own status this run" underneath a stage that had. A
 * detector that only catches the shape somebody thought of is worse than no
 * detector, because the clean bill of health is believed.
 *
 * THE DIFFICULTY IS NOT FINDING FAILURES, IT IS NOT CRYING WOLF.
 *
 * These two are structurally identical:
 *
 *   { created:  false, reason: "MCP tool ... not found" }   <- a real failure
 *   { grounded: false, reason: "nothing missing to ground" } <- correct, normal
 *
 * So a false flag is not a matter of a stricter regex. It needs both halves: a
 * flag whose name asserts an ATTEMPT AT AN ACTION, and a reason that reads like
 * something went wrong. `grounded` is not an action, and "nothing missing to
 * ground" is not a complaint.
 *
 * And a stage that says openly in its status message that it could not
 * determine something is NOT failing silently - it is doing the opposite. Only
 * a contradiction counts here.
 * ------------------------------------------------------------------------- */

/** Keys that assert an action was attempted, so `false` means it did not happen. */
const OUTCOME_FLAGS = [
    'created', 'saved', 'sent', 'written', 'applied', 'updated', 'deleted',
    'ok', 'success', 'succeeded', 'completed', 'posted', 'submitted', 'set'
]

/** Keys that carry the explanation next to such a flag. */
const REASON_KEYS = ['reason', 'message', 'detail', 'details', 'error_message', 'errormessage']

/**
 * Does this text read like something went wrong?
 *
 * Deliberately about failure, not about absence. "nothing missing to ground"
 * and "no existing segment matched" are both normal outcomes and neither is
 * matched here.
 */
const FAILURE_TEXT = /\b(error|errored|failed|failure|exception|not found|missing tool|unknown tool|refused|rejected|denied|unauthori[sz]ed|forbidden|timed? ?out|unreachable|unavailable|not permitted|invalid)\b|-3\d{4}\b/i

function looksLikeFailure (text) {
    return FAILURE_TEXT.test(String(text || ''))
}

/**
 * A failure hiding inside an otherwise successful-looking payload.
 *
 * @param {*} value the stage's output
 * @param {number} [depth]
 * @returns {string|null} what went wrong, or null
 */
function findEmbeddedError (value, depth = 0) {
    if (depth > 8 || value == null) return null

    if (Array.isArray(value)) {
        for (const v of value) {
            const hit = findEmbeddedError(v, depth + 1)
            if (hit) return hit
        }
        return null
    }

    if (typeof value !== 'object') return null

    // 1. An explicit error field. The original check, kept.
    for (const [k, v] of Object.entries(value)) {
        if (['error', 'err', 'exception', 'errors'].includes(k.toLowerCase()) && v) {
            const text = typeof v === 'string' ? v : JSON.stringify(v)
            if (text && text !== '{}' && text !== '[]' && text !== 'false' && text !== 'null') {
                return text.slice(0, 500)
            }
        }
    }

    // 2. MCP's own error envelope.
    if (value.isError === true) {
        const content = Array.isArray(value.content)
            ? value.content.map(c => (c && c.text) || '').filter(Boolean).join(' ')
            : ''
        return (content || 'the tool returned isError: true').slice(0, 500)
    }

    // 3. A declared action that did not happen, with a reason that reads like a
    //    failure. Both halves are required - see the header.
    const keys = Object.keys(value)
    const flag = keys.find(k => OUTCOME_FLAGS.includes(k.toLowerCase()) && value[k] === false)
    if (flag) {
        const reasonKey = keys.find(k => REASON_KEYS.includes(k.toLowerCase()) && value[k])
        const reason = reasonKey ? String(value[reasonKey]) : ''
        if (reason && looksLikeFailure(reason)) {
            return `${flag} is false: ${reason}`.slice(0, 500)
        }
    }

    // 4. A nested status that says failed, where the payload also explains it.
    //    The stage's OWN upstream_status is handled separately; this is for an
    //    inner call that failed inside an outer success.
    const status = String(value.status || '').toLowerCase()
    if (['failed', 'error', 'errored'].includes(status)) {
        const reasonKey = keys.find(k => REASON_KEYS.includes(k.toLowerCase()) && value[k])
        return `status is "${status}"${reasonKey ? `: ${String(value[reasonKey])}` : ''}`.slice(0, 500)
    }

    for (const v of Object.values(value)) {
        const hit = findEmbeddedError(v, depth + 1)
        if (hit) return hit
    }
    return null
}

/**
 * What the run is waiting for, if it is waiting. Null when it is not.
 *
 * Kept separate from the steps because it is the opposite of a step: a step is
 * something that happened, and this is something that did not - the agent was
 * never called. A reader who sees one stage where they expected three needs to
 * be told the other two are behind a gate, or an absent stage reads as a lost
 * one.
 */
function blockedOn (envelope) {
    const b = envelope && envelope.run && envelope.run.blocked_on
    return b && typeof b === 'object' ? b : null
}

/** Decisions recorded at this run's gates, oldest first. */
function gateDecisions (envelope) {
    const g = envelope && envelope.gates
    return Array.isArray(g) ? g : []
}

/**
 * Record a decision at a gate and let the upstream carry on.
 *
 * This does NOT approve anything in Workfront, and the wording throughout says
 * so. Adobe's connector exposes tools to change who sits on an approval stage
 * and none to submit a decision as a person - correctly, because an approval
 * attributable to a service account is not an approval. A human clicks Approve
 * in Workfront; this records that they did, with their name, and unblocks the
 * process.
 */
async function decideGate (system, upstreamRunId, body) {
    const template = system.gate_path || '/api/runs/{run_id}/gate'
    const url = `${system.base_url}${template.replace('{run_id}', encodeURIComponent(upstreamRunId))}`
    /*
     * A long timeout, because opening a gate RUNS THE REST OF THE PIPELINE.
     *
     * The default 30s aborted midway through Agents 2 and 3 and surfaced as
     * "Could not record the decision" - which is doubly wrong: the decision had
     * been recorded, and the agents were still running. A caller told the
     * approval failed would reasonably try again.
     */
    return request(url, {
        method: 'POST',
        headers: { ...headers(system), 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }, 180000)
}

/**
 * What the request WOULD look like, without creating it.
 *
 * Creating notifies the queue by email, so the marketer sees the payload while
 * it is still free to change. This is a read: no object, no mail, no run.
 */
async function previewIntake (system, brief, known) {
    const path = system.preview_path || '/api/intake/preview'
    const url = `${system.base_url}${path}`
    return request(url, {
        method: 'POST',
        headers: { ...headers(system), 'content-type': 'application/json' },
        body: JSON.stringify({ input: { brief, known: known || {} } })
    }, 120000)
}

/**
 * Advance a run by exactly one step.
 *
 * The pipeline deliberately stops after every completed step and waits. This is
 * the thing that says "yes, run the next one" - and without it a run that had
 * been approved and had Agent 2 finish simply sat there, because approving
 * again would have recorded a human decision against a gate nobody was asked
 * about.
 *
 * It does NOT skip the gate: continueRun checks preconditions first and comes
 * back still waiting if the request has not been approved.
 */
async function continueRun (system, upstreamRunId) {
    const template = system.continue_path || '/api/runs/{run_id}/continue'
    const url = `${system.base_url}${template.replace('{run_id}', encodeURIComponent(upstreamRunId))}`
    return request(url, { method: 'POST', headers: { ...headers(system), 'content-type': 'application/json' }, body: '{}' }, 180000)
}

/**
 * Answer a paused run's question, and let it carry on from the step that paused.
 *
 * The alternative - submitting the brief again - creates a second job for the
 * same piece of work, which is what happened before this existed. One job per
 * brief is not tidiness: B1 measures agent health by how many rounds a brief
 * takes, and rounds spread across separate records cannot be counted.
 *
 * Long timeout for the same reason as the gate: answering re-runs an agent.
 */
async function answerRun (system, upstreamRunId, answers) {
    const template = system.resume_path || '/api/runs/{run_id}/resume'
    const url = `${system.base_url}${template.replace('{run_id}', encodeURIComponent(upstreamRunId))}`
    return request(url, {
        method: 'POST',
        headers: { ...headers(system), 'content-type': 'application/json' },
        body: JSON.stringify({ answers })
    }, 180000)
}

/**
 * Normalise the upstream's steps into what we log.
 * `task_run_id` is per STEP and belongs on the event; the run's own id is the
 * join key. Both are kept - neither is a foreign key across the boundary.
 */
function toSteps (envelope) {
    const rows = envelope?.taskRuns || envelope?.task_runs || []
    return rows.map(r => ({
        upstream_task_run_id: r.task_run_id != null ? String(r.task_run_id) : null,
        agent_id: r.task_id,
        step_index: r.step_index,
        upstream_status: r.status,
        input: r.input,
        output: r.output,
        metadata: r.metadata || {},
        duration_ms: r.duration_ms,
        started_at: r.started_at,
        finished_at: r.finished_at,
        embedded_error: findEmbeddedError(r.output)
    }))
}

/**
 * B1's health metric. loopCount is per-step and inconsistently shaped upstream
 * ({loopCount:0} on intake, {} on review, an echo of input elsewhere), so read
 * it defensively rather than assuming a uniform metadata object.
 */
function loopCount (steps) {
    for (const s of steps) {
        if (s.metadata && typeof s.metadata === 'object' && 'loopCount' in s.metadata) {
            const n = Number(s.metadata.loopCount)
            if (Number.isFinite(n)) return n
        }
    }
    return null
}

module.exports = {
    FIELDS,
    merged,
    looksLikeFailure,
    registry, reset, list, get, resolve,
    discoverAgents, startRun, getRun, waitForRun, decideGate, answerRun, continueRun, previewIntake,
    toSteps, loopCount, findEmbeddedError, blockedOn, gateDecisions
}
