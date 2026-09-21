/**
 * A narrated artifact has to link back to what the agent touched.
 *
 * "If agents create something in Workfront, the link should be present in the
 * narrated artifact, so I can go there and review it." The reviewer's next
 * action after reading an artifact is always the same - open the record and
 * look - and making them search Workfront by name for something an agent
 * created a second ago is the friction that stops review happening.
 *
 * The rule these tests hold: a link when we can build a trustworthy one, an
 * explicit note when we know the object but cannot link to it, and NEVER a
 * guessed URL. A broken link costs more than a missing one, because it teaches
 * the reader not to trust the next one.
 */

const narrate = require('../lib/narrate')

const TENANT = 'taplondonptrsd.my.workfront.com'

describe('workfrontUrl', () => {
    test('builds an issue link from an objCode and id', () => {
        expect(narrate.workfrontUrl('OPTASK', '5f2a1b', TENANT))
            .toBe(`https://${TENANT}/issue/5f2a1b`)
    })

    test('knows the object codes the pipeline actually produces', () => {
        expect(narrate.workfrontUrl('PROJ', '1', TENANT)).toBe(`https://${TENANT}/project/1`)
        expect(narrate.workfrontUrl('TASK', '1', TENANT)).toBe(`https://${TENANT}/task/1`)
        expect(narrate.workfrontUrl('DOCU', '1', TENANT)).toBe(`https://${TENANT}/document/1`)
    })

    test('refuses an unknown object code rather than inventing a path', () => {
        // A guessed path 404s, and a reviewer who clicks one broken link stops
        // clicking them.
        expect(narrate.workfrontUrl('WHATEVER', '1', TENANT)).toBeNull()
    })

    test('refuses when there is no tenant, and when there is no id', () => {
        expect(narrate.workfrontUrl('OPTASK', '1', null)).toBeNull()
        expect(narrate.workfrontUrl('OPTASK', '', TENANT)).toBeNull()
    })

    test('tolerates a tenant written as a URL, or with a trailing slash', () => {
        expect(narrate.workfrontUrl('OPTASK', '9', `https://${TENANT}/`))
            .toBe(`https://${TENANT}/issue/9`)
    })

    test('escapes the id, so an odd id cannot break out of the URL', () => {
        expect(narrate.workfrontUrl('OPTASK', 'a b&c', TENANT)).toContain('/issue/a%20b%26c')
    })
})

describe('findWorkfrontRefs', () => {
    test('finds the shape the intake agent reports', () => {
        const refs = narrate.findWorkfrontRefs({
            brief: 'x',
            workfront: { created: true, objId: '5f2a1b', objCode: 'OPTASK', customFieldsSet: true }
        })
        expect(refs).toEqual([{ objCode: 'OPTASK', objId: '5f2a1b' }])
    })

    test('finds a bare connector response, which uses ID and objCode', () => {
        const refs = narrate.findWorkfrontRefs({ data: { ID: '77', objCode: 'PROJ' } })
        expect(refs).toEqual([{ objCode: 'PROJ', objId: '77' }])
    })

    test('does not report the same object twice', () => {
        const refs = narrate.findWorkfrontRefs({
            a: { objId: '1', objCode: 'OPTASK' },
            b: { objId: '1', objCode: 'OPTASK' }
        })
        expect(refs).toHaveLength(1)
    })

    test('ignores an id with no object code - it could be anything', () => {
        expect(narrate.findWorkfrontRefs({ id: 'job-123', title: 'x' })).toEqual([])
    })

    test('ignores an object code it does not recognise', () => {
        expect(narrate.findWorkfrontRefs({ x: { objId: '1', objCode: 'MYSTERY' } })).toEqual([])
    })

    test('survives a payload that is not an object', () => {
        expect(narrate.findWorkfrontRefs(null)).toEqual([])
        expect(narrate.findWorkfrontRefs('a string')).toEqual([])
    })
})

describe('the narrated artifact', () => {
    const step = {
        agent_id: 'intake',
        upstream_status: 'completed',
        duration_ms: 1730,
        output: {
            campaign_name: 'Fall Switch and Save',
            workfront: { created: true, objId: '5f2a1b', objCode: 'OPTASK' }
        }
    }

    test('carries a clickable link when the tenant is known', () => {
        const md = narrate.narrateStep(step, 'Agent 1 — Intake', { workfrontInstance: TENANT })
        expect(md).toContain('**In Workfront**')
        expect(md).toContain(`https://${TENANT}/issue/5f2a1b`)
    })

    test('puts the link ABOVE anything that restates the payload', () => {
        /*
         * This used to name the "What it produced" table, which no longer
         * exists - the payload's short values are stated on one line now and
         * the rest is left to the captured JSON. The rule it was protecting is
         * unchanged: the link is the one thing a reviewer acts on, so nothing
         * that merely repeats the output may come before it.
         */
        const md = narrate.narrateStep(step, 'Agent 1 — Intake', { workfrontInstance: TENANT })
        const link = md.indexOf('**In Workfront**')
        const restated = md.indexOf('**campaign_name:**')
        expect(link).toBeGreaterThan(-1)
        expect(restated).toBeGreaterThan(-1)
        expect(link).toBeLessThan(restated)
    })

    test('names the object and says why there is no link, when no tenant is set', () => {
        const md = narrate.narrateStep(step, 'Agent 1 — Intake', {})
        // Silence here reads as "nothing was created", which is a different and
        // much worse claim than "created, but I cannot link to it".
        expect(md).toContain('OPTASK 5f2a1b')
        expect(md).toMatch(/no tenant configured/i)
        expect(md).not.toContain('https://')
    })

    test('says nothing at all when the agent touched nothing in Workfront', () => {
        const md = narrate.narrateStep(
            { agent_id: 'review', upstream_status: 'completed', output: { reviewed: true } },
            'Agent 2 — Review',
            { workfrontInstance: TENANT }
        )
        expect(md).not.toContain('In Workfront')
    })

    test('still links on a FAULTED step - that is exactly when you want to look', () => {
        const faulted = { ...step, embedded_error: 'search_knowledge_base not found' }
        const md = narrate.narrateStep(faulted, 'Agent 1 — Intake', { workfrontInstance: TENANT })
        expect(md).toContain('reported success')
        expect(md).toContain(`https://${TENANT}/issue/5f2a1b`)
    })
})
