/**
 * What the calling AI read has to reach the pipeline.
 *
 * The harness's intake route has always accepted `input.fields` —
 * `parseBrief(brief, body.input?.fields || {})` — and this side never sent
 * any. So the deterministic parser read the brief alone, and its LAYOUT
 * decided the outcome. Measured on two live runs of the identical Xfinity
 * brief:
 *
 *   rows written "Label: value"        -> 1 round,  2 questions
 *   rows separated by a TAB            -> 7 rounds, 14 questions
 *
 * The tab form is what copying the BU's table out of Workfront produces, so
 * the format the business actually uses was the one that read as empty, and
 * the marketer was asked for fourteen things the table answered on screen.
 *
 * A marketer reaches this through an AI that has already read that table.
 * These tests are about the wire: if `fields` stops arriving upstream, the
 * layout starts deciding again and nothing else fails.
 */

const agentSystems = require('../lib/agent-systems')

const SYSTEM = {
    id: 'test-harness',
    base_url: 'https://harness.test',
    start_path: '/api/runs',
    run_id_key: 'run_id',
    input_key: 'brief',
    input_envelope: 'input'
}

/** The last body startRun sent, parsed. */
let sent

beforeEach(() => {
    sent = null
    global.fetch = jest.fn(async (url, init) => {
        sent = { url, body: JSON.parse(init.body) }
        return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ run_id: 'run-1' }),
            text: async () => JSON.stringify({ run_id: 'run-1' })
        }
    })
})

afterEach(() => { delete global.fetch })

describe('startRun carries the fields the caller already read', () => {
    test('the brief still goes where it went', async () => {
        await agentSystems.startRun(SYSTEM, 'a brief')
        expect(sent.url).toBe('https://harness.test/api/runs')
        expect(sent.body).toEqual({ input: { brief: 'a brief' } })
    })

    test('fields ride INSIDE the envelope, beside the brief', async () => {
        // Not beside `input`, and not renamed: the upstream reads
        // body.input.fields, so anywhere else is silently ignored - which is
        // exactly how this went unnoticed for so long.
        await agentSystems.startRun(SYSTEM, 'a brief', {
            request_type: 'Audience + Campaign Execution',
            launch_date: '2026-10-19'
        })
        expect(sent.body).toEqual({
            input: {
                brief: 'a brief',
                fields: {
                    request_type: 'Audience + Campaign Execution',
                    launch_date: '2026-10-19'
                }
            }
        })
    })

    test('no fields means no key at all, not an empty object', async () => {
        // An empty `fields` is indistinguishable upstream from "I read the
        // brief and it says nothing", and the parser treats a supplied value
        // differently from an absent one. Sending {} would assert something.
        for (const absent of [undefined, null, {}]) {
            await agentSystems.startRun(SYSTEM, 'a brief', absent)
            expect(Object.keys(sent.body.input)).toEqual(['brief'])
        }
    })

    test('a system with no envelope gets the fields at the top level', async () => {
        // The envelope is configuration, so this must follow it rather than
        // hardcoding the one upstream we happen to run today.
        await agentSystems.startRun(
            { ...SYSTEM, input_envelope: null },
            'a brief',
            { region: 'Northeast' }
        )
        expect(sent.body).toEqual({ brief: 'a brief', fields: { region: 'Northeast' } })
    })

    test('a non-object fields is ignored rather than sent', async () => {
        await agentSystems.startRun(SYSTEM, 'a brief', 'request_type=whatever')
        expect(Object.keys(sent.body.input)).toEqual(['brief'])
    })
})

describe('the tool asks for them, by name', () => {
    const { toolDescriptions } = (() => {
        // The registry is built by registerTools against a live server, so read
        // the description text from the source instead of standing a server up
        // for one string. It is the text the client is served either way.
        const fs = require('fs')
        const path = require('path')
        const src = fs.readFileSync(path.join(__dirname, '../actions/mcp-server/tools.js'), 'utf8')
        return { toolDescriptions: src }
    })()

    test('every field the pipeline can accept is named for the client', () => {
        // A key the client is not told about is a key it will not send, and
        // the pipeline will go back to asking the marketer for it.
        for (const key of [
            'campaign_name', 'business_objective', 'customer_type', 'line_of_business',
            'request_type', 'launch_date', 'lifecycle_journey', 'campaign_duration',
            'cadence', 'activation_pattern', 'channels', 'region', 'offer',
            'exclusion', 'audience_description'
        ]) {
            expect(toolDescriptions).toContain(key)
        }
    })

    test('the client is told to omit what the brief does not say', () => {
        // The opposite failure to the one being fixed: a client that fills
        // every key to look complete builds a campaign on invented values.
        expect(toolDescriptions).toContain('Omit a key the brief is silent on')
        expect(toolDescriptions).toContain('Do not infer one to look complete')
    })

    test('the brief is still wanted verbatim, not summarised', () => {
        // fields are the caller's reading; the brief is the evidence every
        // value is grounded against. A summary destroys the grounding check.
        expect(toolDescriptions).toContain('verbatim, including its table, not your summary of it')
    })
})
