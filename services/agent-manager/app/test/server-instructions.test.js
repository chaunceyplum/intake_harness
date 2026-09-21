/**
 * The instructions are a product surface, and they are the one this project
 * keeps getting bitten by.
 *
 * They are served over MCP at `initialize`, so they arrive AFTER the client's
 * own system prompt and describe the tools being offered - which means they
 * out-argue anything set on the client side. A connected Claude Desktop was
 * handed a brief and asked to start an intake, and instead:
 *
 *   - searched for similar prior work, because ANOTHER connected server's
 *     instructions say to reuse before you rebuild,
 *   - opened a subagent of its own that read fifty-two files off the local
 *     disk to "summarise existing campaign intake job steps",
 *   - then declined to start a run at all, citing a "one run per intake" rule
 *     that does not exist, because it found an older run with the same words.
 *
 * Nothing was filed, and the marketer waited minutes for that. Every stage in
 * the pipeline runs in seconds, so the whole delay was the client looking
 * around before its first tool call.
 *
 * These assertions are deliberately about CONTENT, not wording. Each one is a
 * behaviour that went wrong in front of a client; if a future edit tidies the
 * text and drops one, that is the regression, not a style change.
 */

const { SERVER_INSTRUCTIONS } = require('../actions/mcp-server/tools')

/** Case-insensitive, whitespace-tolerant search - the text is reflowed often. */
function says (needle) {
    const flat = SERVER_INSTRUCTIONS.replace(/\s+/g, ' ').toLowerCase()
    return flat.includes(String(needle).replace(/\s+/g, ' ').toLowerCase())
}

describe('the instructions tell a client to file the brief, not research it', () => {
    test('start_intake is named as the FIRST call for a brief', () => {
        expect(says('call start_intake with it')).toBe(true)
        expect(says('that is the FIRST tool call')).toBe(true)
    })

    test('the research detour is refused by name, each way it actually happened', () => {
        // Searching for prior work.
        expect(says('do not search for similar past work')).toBe(true)
        // Reading the local disk.
        expect(says('do not read files off the machine you are running on')).toBe(true)
        // Opening its own subagent.
        expect(says('do not open a subagent')).toBe(true)
    })

    test('the other server\'s reuse-before-you-rebuild rule is disclaimed', () => {
        // The cookbook's instructions are correct for a cookbook and cannot be
        // changed from here, so this server has to say they do not apply.
        expect(says('that rule is for a knowledge store, and it does not apply here')).toBe(true)
    })

    test('a brief resembling an older run is still a new request', () => {
        expect(says('still a new request')).toBe(true)
        expect(says('there is no "one run per brief" rule')).toBe(true)
        // The instruction has to say what to DO, not only what not to do -
        // "refuse" was the failure, so the replacement behaviour is named.
        expect(says('FILE IT and say what you noticed')).toBe(true)
    })

    test('the narrow no-duplicate rule is bounded, where it is stated', () => {
        // This section is what the client generalised into a refusal. It now
        // points at the section that contradicts that reading.
        const at = SERVER_INSTRUCTIONS.indexOf('ANSWERING A QUESTION IS NOT STARTING A NEW JOB')
        expect(at).toBeGreaterThan(-1)
        const section = SERVER_INSTRUCTIONS.slice(at, at + 700).replace(/\s+/g, ' ').toLowerCase()
        expect(section).toContain('a run you are already holding')
        expect(section).toContain('not about a new brief that resembles an old one')
    })

    test('the agents are named as upstream, and a subagent is excluded from them', () => {
        expect(says('the agents are upstream')).toBe(true)
        expect(says('list_system_agents names')).toBe(true)
    })

    test('the client is told where the time actually goes', () => {
        // Without this, "it was slow" gets attributed to the pipeline, and the
        // next person optimises the wrong half.
        expect(says('the pipeline’s own compute is SECONDS') ||
               says("the pipeline's own compute is SECONDS")).toBe(true)
        expect(says('waiting on a person')).toBe(true)
    })

    /*
     * The oldest failure in this file's history, kept because it is the reason
     * the instructions exist at all: this service was built on the cookbook's
     * engine and inherited its "capture whatever you produce" instructions, so
     * a connected client began filing architecture diagrams from an unrelated
     * conversation into Agent Manager.
     */
    test('it still says this is not a place to file your own work', () => {
        expect(says('IT IS NOT A PLACE TO FILE YOUR OWN WORK')).toBe(true)
    })
})
