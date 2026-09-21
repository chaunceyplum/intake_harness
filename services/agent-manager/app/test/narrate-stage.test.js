/**
 * The agent log is for reading, and it had stopped being readable.
 *
 * Every key of a step's output was printed as a table row. Agent 1 rendered the
 * whole brief, the parsed `fields` JSON and the stated/inferred/missing/
 * grounding arrays; Agent 2 carried all of that forward and added a 1,521
 * character raw API response; Agent 3 put the AEP segment link inside a 778
 * character JSON blob in a single cell.
 *
 * None of it was ever lost - the full output is stored on the step and served
 * by the API - so printing it again was not transparency. It buried the two
 * lines anybody acts on: the Workfront request and the audience that was built.
 */

const { narrateStep } = require('../lib/narrate')

const INTAKE = {
    id: 'step-1',
    kind: 'message',
    output: {
        brief: 'We need an audience for the NY attach push, existing internet customers...',
        fields: { region: 'New York', channels: 'Email' },
        intakeFields: { region: 'New York', channels: 'Email' },
        stated: ['region', 'channels'],
        inferred: [{ key: 'customer_type', value: 'Subscriber - Existing Customers' }],
        missing: [],
        grounding: { hits: null, grounded: false },
        workfrontPayload: { fields: { name: 'NY Attach', categoryID: 'abc' } },
        workfront: { objCode: 'OPTASK', objId: '6aadceda00014e6c125707c77f9a703f', created: true },
        loopCount: 0,
    },
}

const AUDIENCE = {
    id: 'step-3',
    kind: 'message',
    output: {
        audience: {
            name: 'NY Attach Q4',
            url: 'https://experience.adobe.com/#/@t/sname:tapdemo/platform/segment/browse/b35d',
            segmentId: 'b35d6709-d952-4116-ac6d-14f575b0e881',
            definition: '_t.xfinityTV = true and _t.xfinityInternet = false',
            reads: ['holds TV', 'does NOT hold Internet - the exclusion that defines the upsell'],
            created: true,
            error: null,
        },
        predictedCount: 5,
        buildPath: 'aep_rule_builder',
    },
}

const OPTS = { workfrontInstance: 'taplondonptrsd' }

describe('the raw payload is not reprinted', () => {
    const md = narrateStep(INTAKE, 'Agent 1 — Intake', OPTS)

    test.each(['brief', 'fields', 'intakeFields', 'stated', 'inferred', 'grounding', 'workfrontPayload'])(
        'does not print %s as a row', (key) => {
            expect(md).not.toMatch(new RegExp(`\\|\\s*${key}\\s*\\|`))
        })

    test('still links the Workfront request, which is the point', () => {
        expect(md).toContain('6aadceda00014e6c125707c77f9a703f')
        expect(md).toMatch(/In Workfront/)
    })

    /*
     * The filter is a named list, not "hide everything". A stage that produces
     * something a human should read must keep showing it, or the next person
     * fixes the log by deleting the filter.
     */
    test('a value worth reading is still shown', () => {
        const other = narrateStep(
            { id: 's', kind: 'message', output: { predictedCount: 5, statusMessage: 'counted from the profile table' } },
            'Agent 3', OPTS,
        )
        expect(other).toMatch(/predictedCount/)
        expect(other).toMatch(/statusMessage/)
    })
})

describe('the audience is rendered, not dumped', () => {
    const md = narrateStep(AUDIENCE, 'Agent 3 — Audience', OPTS)

    test('the segment link is a link, not a character in a JSON blob', () => {
        expect(md).toMatch(/\[NY Attach Q4\]\(https:\/\/experience\.adobe\.com/)
    })

    test("the definition appears in the agent's own English", () => {
        expect(md).toContain('holds TV')
        expect(md).toContain('the exclusion that defines the upsell')
    })

    test('the raw audience object is not also printed as a row', () => {
        expect(md).not.toMatch(/\|\s*audience\s*\|/)
    })

    test('a failure to build is stated plainly', () => {
        const failed = narrateStep(
            { id: 's', kind: 'message', output: { audience: { name: 'X', segmentId: 'z', error: 'PQL was refused' } } },
            'Agent 3', OPTS,
        )
        expect(failed).toContain('It did not build')
        expect(failed).toContain('PQL was refused')
    })
})
