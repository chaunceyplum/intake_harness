/**
 * The "What it produced" table is gone, and the values worth reading are not.
 *
 * On the two stages that carry the most state the table was the longest thing
 * on screen and the least readable. The Architect rendered as
 * mode / catalog / approval / reviewed / converted / loopCount with two cells
 * truncated mid-sentence; Tank put a 300-character identityGap and a
 * two-sentence statusMessage into single cells. None of it was ever at risk -
 * the whole payload is stored on the step - so reprinting it was not
 * transparency, it was noise in front of the count.
 *
 * Removing the block outright was the first attempt and it was too blunt: it
 * took `predictedCount` with it, which is the audience size and the headline
 * number of the run. narrate-stage.test.js caught that, which is why these
 * tests are about the SHAPE of a value rather than about which agent produced
 * it. A number reads fine in a sentence; an object never read fine in a cell.
 */

const { narrateStep } = require('../lib/narrate')

/** The Architect, with the payload from a real run. */
const ARCHITECT = {
    upstream_status: 'completed',
    output: {
        mode: 'phase2',
        catalog: { note: 'No existing audience matched (50 checked), so a new one is needed. It will need line_of_business, channels and region, once those attributes are confirmed to exist in AEP.' },
        approval: { at: '2026-09-21T13:48:06.801Z', by: 'bharat.dudeja@tapcxm.com', decision: 'approved' },
        reviewed: true,
        converted: { objId: '6ab1359d000d0757b37ad280ed0e079b', method: 'created_project_and_linked' },
        loopCount: 0
    }
}

/** Tank, same run. */
const TANK = {
    upstream_status: 'completed',
    output: {
        buildPath: 'aep_rule_builder',
        identityGap: { hasGap: true, details: 'This brief is written in account terms (subscribers/accounts/households) and AEP counts resolved profiles. One household can resolve to several profiles, so the audience count will not equal the household count.' },
        statusMessage: 'AEP rule builder: Every attribute this audience needs is present in AEP, so the rule builder covers it. Checked 44 field(s) across 20 profile schema(s) in tenant "taplondonptrsd". No existing audience matched (50 checked).',
        predictedCount: 29,
        attributesAvailable: true,
        openAttributeRequest: { status: 'not_opened', requestId: null, ageSeconds: null }
    }
}

describe('a stage states its scalars and does not tabulate its payload', () => {
    test('no field table is rendered at all', () => {
        for (const [name, step] of [['architect', ARCHITECT], ['tank', TANK]]) {
            const md = narrateStep(step, name, {})
            expect(md).not.toContain('What it produced')
            // The table's own header row, which is what made it a table.
            expect(md).not.toContain('| Field | Value | Source |')
        }
    })

    test('the audience count survives - this is the one the first attempt lost', () => {
        const md = narrateStep(TANK, 'Tank', {})
        expect(md).toContain('**predictedCount:** 29')
    })

    test('short values are stated on one line, not one row each', () => {
        const md = narrateStep(ARCHITECT, 'The Architect', {})
        const line = md.split('\n').find(l => l.includes('**mode:**'))
        expect(line).toBeTruthy()
        // reviewed and loopCount ride the same line rather than each taking a row
        expect(line).toContain('**reviewed:** true')
        expect(line).toContain('**loopCount:** 0')
    })

    test('a paragraph and an object are NOT restated, however short they look', () => {
        const md = narrateStep(TANK, 'Tank', {})
        // The statusMessage's opening words would have been the giveaway.
        expect(md).not.toContain('Every attribute this audience needs')
        expect(md).not.toContain('One household can resolve to several profiles')
        expect(md).not.toContain('not_opened')
    })

    test('what was left out is NAMED, so an absent table does not read as lost data', () => {
        // A reviewer who wants the raw values has to know they exist and where.
        // Silence here would be indistinguishable from the agent not producing
        // them, which is the failure this whole project exists to catch.
        const md = narrateStep(TANK, 'Tank', {})
        expect(md).toContain('captured verbatim as JSON on this run')
        for (const key of ['identityGap', 'statusMessage', 'openAttributeRequest']) {
            expect(md).toContain('`' + key + '`')
        }
    })

    test('a stage whose values are all short says nothing about JSON', () => {
        // The "also recorded" line is only honest when something really was
        // left out. Printing it unconditionally would be noise of its own.
        const md = narrateStep({ upstream_status: 'completed', output: { mode: 'phase2', reviewed: true } }, 'x', {})
        expect(md).toContain('**mode:** phase2')
        expect(md).not.toContain('captured verbatim as JSON')
    })

    test('a flagged field is still reported, and is not quietly inlined', () => {
        // The unset/ambiguous/failed line is the silent-failure signal and must
        // not be lost to a formatting change.
        const md = narrateStep({
            upstream_status: 'completed',
            output: { mode: 'phase2', segmentId: null }
        }, 'x', {})
        expect(md).toMatch(/unset, ambiguous or failed/)
        expect(md).toContain('segmentId')
    })
})
