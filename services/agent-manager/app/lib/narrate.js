/**
 * Turning an upstream step into something a person can read.
 *
 * The cookbook demo that started this project logged narrative: titled
 * decisions, a field table with a Source column, corrections with what they
 * cost, a wait log, a time ledger. A reviewer could read it top to bottom and
 * understand what happened.
 *
 * The first cut of start_intake logged `JSON.stringify(upstream)`. Technically
 * complete, and useless to read - which defeats the point of keeping a record
 * at all.
 *
 * So this module writes markdown: a heading, what the stage actually did, a
 * field table where there are fields, and the raw payload kept underneath as
 * evidence rather than as the headline.
 *
 * Nothing here invents content. Every line is derived from what the upstream
 * returned, and where a value was inferred rather than stated, the table says
 * so - a brief that looks complete because the agent guessed is exactly the
 * failure the record exists to catch.
 */

/* ---------------------------------------------------------------------------
 * Linking back to Workfront.
 *
 * An artifact that says an agent created an issue, without saying WHICH issue,
 * is not reviewable. The reviewer's next action is always the same - open the
 * thing and look at it - and making them search Workfront by name for a record
 * an agent just created is the kind of small friction that stops review
 * happening at all.
 *
 * Workfront's object URLs are stable and predictable per object code, so the id
 * an agent reports is enough to build one.
 * ------------------------------------------------------------------------- */

/** objCode -> the path Workfront serves that object at. */
const WORKFRONT_PATHS = {
    OPTASK: 'issue',
    TASK: 'task',
    PROJ: 'project',
    PORT: 'portfolio',
    PRGM: 'program',
    TMPL: 'template',
    DOCU: 'document',
    USER: 'user'
}

/**
 * A deep link to one Workfront object.
 *
 * @param {string} objCode e.g. OPTASK
 * @param {string} objId Workfront's own id
 * @param {string} instance the tenant host, e.g. acme.my.workfront.com
 * @returns {string|null} null when we cannot build a trustworthy URL
 */
function workfrontUrl (objCode, objId, instance) {
    if (!objId || !instance) return null
    const path = WORKFRONT_PATHS[String(objCode || '').toUpperCase()]
    // An unknown object code would produce a URL that 404s. A missing link is
    // better than a broken one: the reader trusts the next link less either way.
    if (!path) return null
    const host = String(instance).replace(/^https?:\/\//, '').replace(/\/+$/, '')
    // Workfront's own responses link as /issue/<id>, not /issue/view?ID=<id>.
    // Both resolve, but matching what the platform itself emits means a link
    // pasted from here and one copied from Workfront are the same link.
    return `https://${host}/${path}/${encodeURIComponent(objId)}`
}

/**
 * Anything in a step's output that names a Workfront object.
 *
 * Agents report this inconsistently - `workfront: {objId, objCode}` from the
 * intake agent, a bare `ID` from a raw connector response - so this looks for
 * the shapes that actually occur rather than insisting on one.
 *
 * @returns {{objCode: string, objId: string}[]}
 */
function findWorkfrontRefs (value, depth = 0, out = []) {
    if (depth > 6 || value == null || typeof value !== 'object') return out
    if (Array.isArray(value)) {
        for (const v of value) findWorkfrontRefs(v, depth + 1, out)
        return out
    }
    const objId = value.objId || value.objID || value.ID || value.id
    const objCode = value.objCode || value.objectCode
    if (objId && objCode && WORKFRONT_PATHS[String(objCode).toUpperCase()]) {
        const key = `${objCode}:${objId}`
        if (!out.some(r => `${r.objCode}:${r.objId}` === key)) {
            out.push({ objCode: String(objCode), objId: String(objId) })
        }
    }
    for (const v of Object.values(value)) findWorkfrontRefs(v, depth + 1, out)
    return out
}

/** Values that are answers in form but not in substance. */
const AMBIGUOUS = ['not sure', 'unknown', 'n/a', 'tbc', 'tbd', 'none', '']

function isAmbiguous (value) {
    return AMBIGUOUS.includes(String(value == null ? '' : value).trim().toLowerCase())
}

function short (value, max = 220) {
    if (value == null) return ''
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Markdown table cells must not break the table. */
function cell (value) {
    return short(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function seconds (ms) {
    if (ms == null) return '—'
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * Flatten an output object one level into rows, so a stage's result reads as a
 * table rather than a blob. Nested objects are summarised, not expanded - the
 * raw payload is kept below for anyone who needs the whole thing.
 */
/*
 * THE RAW PAYLOAD IS ALREADY CAPTURED. THIS TABLE IS FOR READING.
 *
 * Every key of a step's output was printed here, so Agent 1 rendered the whole
 * brief, the parsed `fields` JSON, and the `stated` / `inferred` / `missing` /
 * `grounding` arrays - four screens of it - above the one line anybody acts
 * on, which is the link to the Workfront request.
 *
 * None of it is lost: the full output is stored on the step and served by the
 * API. Printing it again in a reviewer's face is not transparency, it is the
 * link being buried, which is the exact failure the link was moved above the
 * table to avoid.
 *
 * Anything NOT on this list still shows. A stage that produces something a
 * human should read - a predicted count, an identity gap, a status message -
 * is unaffected.
 */
const RAW_PAYLOAD_KEYS = new Set([
    // The input. The reviewer just read it, or can open the request and see it.
    'brief', 'input',
    // The parse, in machine form. `captured` in the preview is the readable one.
    'fields', 'stated', 'inferred', 'missing', 'grounding',
    // Rendered above as a clickable link, which is the whole point.
    'workfront',
    /*
     * Agent 2 carries the whole of Agent 1's output forward, so the review
     * stage reprinted the brief, the parsed fields and the intake payload a
     * second time before reaching anything it had decided itself.
     *
     * intakeFields duplicates fields; workfrontPayload is the raw request body
     * we sent; conversion is the raw API response, of which `converted` is the
     * readable summary. Keeping the summaries and dropping the wire format is
     * the whole distinction.
     */
    'intakeFields', 'workfrontPayload', 'conversion',
    // Rendered below as a link and a plain-English definition.
    'audience',
])

function rows (output) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return []
    return Object.entries(output)
        .filter(([key]) => !RAW_PAYLOAD_KEYS.has(key))
        .map(([key, value]) => {
        let note = 'stated by the agent'

        /*
         * An EMPTY LIST IS NOT A MISSING VALUE.
         *
         * isAmbiguous stringifies its input, so [] became '' and was flagged as
         * "ambiguous - does not identify anything". The field most often
         * affected is called `missing`, so a run where nothing was missing
         * printed "1 of 10 fields is unset, ambiguous or failed: missing" -
         * reporting the best possible outcome as a defect.
         *
         * That matters beyond tidiness: this line is how a reader decides
         * whether to look closer, and a flag that fires on good news trains
         * them to ignore it, which is the one thing it cannot afford.
         */
        const emptyList = Array.isArray(value) && value.length === 0
        const emptyObject = value && typeof value === 'object' && !Array.isArray(value) &&
            Object.keys(value).length === 0

        if (emptyList || emptyObject) note = 'none'
        else if (value == null) note = '**not set**'
        else if (isAmbiguous(value)) note = '**ambiguous** — does not identify anything'
        else if (typeof value === 'object' && value && (value.error || value.err)) note = '**failed**'
        // A value the agent openly reports as undetermined is honest, not broken.
        else if (String(value).toLowerCase() === 'undetermined') note = 'undetermined, and says so'

        /*
         * IS THIS VALUE READABLE IN PLACE, OR ONLY IN THE JSON?
         *
         * A number, a boolean or a short word can be stated in a sentence. An
         * object, a list or a paragraph cannot - and that is exactly what made
         * two stages unreadable, with a 300-character identityGap and a
         * two-sentence statusMessage rendered into single table cells.
         *
         * Read off the ORIGINAL value, not off `cell()`, which has already
         * stringified and truncated it - by then a trimmed object looks like a
         * short string.
         */
        const scalar = (typeof value === 'number' || typeof value === 'boolean') ||
            (typeof value === 'string' && value.length <= 60 && !/[\r\n]/.test(value))

        return { key, value: cell(value), note, scalar }
    })
}

/**
 * One stage of a run, as markdown.
 *
 * @param {object} step normalised step (see agent-systems.toSteps)
 * @param {string} label the agent's display name, from the upstream registry
 * @returns {string} markdown
 */
function narrateStep (step, label, opts = {}) {
    const faulted = !!step.embedded_error
    const heading = faulted
        ? `### ${label} — reported success, but its tool call failed`
        : `### ${label}`

    const lines = [heading, '']

    lines.push(
        `**Reported:** \`${step.upstream_status}\`  ·  ` +
        `**Actually:** ${faulted ? '`faulted`' : `\`${step.upstream_status}\``}  ·  ` +
        `**Took:** ${seconds(step.duration_ms)}`
    )
    lines.push('')

    if (faulted) {
        lines.push(
            `The step returned \`${step.upstream_status}\`, but its output carries an error:`,
            '',
            `> ${short(step.embedded_error, 400)}`,
            '',
            'The failure was written into the payload instead of being raised, so the ' +
            'pipeline carried on and the run reads as a success. Nothing downstream was ' +
            'told, and because the status never became `failed`, the escalation agent was ' +
            'never invoked.',
            ''
        )
    }

    /*
     * The link goes ABOVE the field table, not in it.
     *
     * It is the one thing a reviewer acts on, and a URL buried in a row of a
     * table of eleven fields is a URL nobody clicks.
     */
    const refs = findWorkfrontRefs(step.output)
    const links = refs
        .map(r => ({ ...r, url: workfrontUrl(r.objCode, r.objId, opts.workfrontInstance) }))
        .filter(r => r.url)
    if (links.length) {
        lines.push('**In Workfront**', '')
        for (const l of links) {
            lines.push(`- [${l.objCode} ${l.objId}](${l.url}) — open it to review what the agent actually wrote.`)
        }
        lines.push('')
    } else if (refs.length) {
        // We know what it touched and cannot link to it. Say which, rather than
        // leaving the reviewer to wonder whether anything was created at all.
        lines.push(
            `**In Workfront:** ${refs.map(r => `${r.objCode} ${r.objId}`).join(', ')} ` +
            '(no tenant configured, so no direct link — set the instance on the Workfront ' +
            'MCP server in Settings).',
            ''
        )
    }

    /*
     * THE SEGMENT LINK, FOR THE SAME REASON THE WORKFRONT LINK IS ABOVE.
     *
     * Agent 3's `audience` arrived as a 778-character JSON blob in one table
     * cell, with the AEP link inside it. That link is the thing a reviewer
     * opens, and the definition in the agent's own English is the thing they
     * check it against - both were unreadable in a cell.
     */
    const aud = step.output && typeof step.output === 'object' ? step.output.audience : null
    if (aud && typeof aud === 'object' && (aud.url || aud.segmentId || aud.definition)) {
        lines.push('**In Adobe Experience Platform**', '')
        if (aud.url) {
            lines.push(`- [${aud.name || 'the audience'}](${aud.url}) — open it to see the rule that was built.`)
        } else if (aud.segmentId) {
            lines.push(`- Segment \`${aud.segmentId}\`${aud.name ? ` — ${aud.name}` : ''}`)
        }
        if (Array.isArray(aud.reads) && aud.reads.length) {
            lines.push('', 'It reaches someone who:')
            for (const r of aud.reads) lines.push(`- ${r}`)
        } else if (aud.definition) {
            lines.push('', `Definition: \`${aud.definition}\``)
        }
        if (aud.error) lines.push('', `**It did not build:** ${aud.error}`)
        lines.push('')
    }

    /*
     * NO TABLE. THE VALUES THAT READ AS A SENTENCE ARE SAID AS ONE.
     *
     * This used to render every remaining key as a row of a "What it produced"
     * table, and on the two stages carrying the most state it was the longest
     * thing on screen and the least readable. The Architect's came out as
     * mode / catalog / approval / reviewed / converted / loopCount with two
     * cells truncated mid-sentence; Tank's put a 300-character identityGap and
     * a two-sentence statusMessage into single cells.
     *
     * Removing the whole block was the first attempt and it went too far: it
     * took `predictedCount` with it, which is the audience size and the
     * headline number of the run. So the split is by the SHAPE of the value,
     * not by which agent produced it. Scalars are stated inline. Objects,
     * lists and paragraphs are not repeated here at all - they are held
     * verbatim as JSON on the same run, and a table cell was never able to
     * show them anyway.
     */
    const table = rows(step.output)

    const flagged = table.filter(r => r.note.startsWith('**'))
    const readable = table.filter(r => r.scalar && !r.note.startsWith('**'))
    if (readable.length) {
        lines.push(readable.map(r => `**${r.key}:** ${r.value}`).join('  ·  '), '')
    }
    if (flagged.length) {
        lines.push(
            `${flagged.length} of ${table.length} field${table.length === 1 ? '' : 's'} ` +
            `${flagged.length === 1 ? 'is' : 'are'} unset, ambiguous or failed: ` +
            `${flagged.map(f => f.key).join(', ')}.`,
            ''
        )
    }

    const buried = table.filter(r => !r.scalar && !r.note.startsWith('**'))
    if (buried.length) {
        // Not "nothing to see": a reviewer who wants these needs to know they
        // exist and where, or an absent table reads as lost data.
        lines.push(
            `It also recorded ${buried.map(r => `\`${r.key}\``).join(', ')} — too long to ` +
            'restate here, captured verbatim as JSON on this run.',
            ''
        )
    }

    if (step.metadata && Object.keys(step.metadata).length) {
        const loop = step.metadata.loopCount
        if (loop != null) {
            lines.push(
                `**Loop count:** ${loop}` +
                (Number(loop) > 2
                    ? ' — above two rounds. Per B1 that means the agent failed, not the marketer.'
                    : ''),
                ''
            )
        }
    }

    // The raw payload is NOT inlined. It is attached to the step's provenance,
    // and the dashboard shows it behind a View JSON toggle - so the narrative
    // reads as narrative, and the exact response stays one click away.

    return lines.join('\n')
}

/**
 * The opening artifact: the marketer's brief, verbatim, and what it was sent to.
 * Captured before any agent touches it, because everything downstream is judged
 * against it.
 */
function narrateBrief (brief, system) {
    return [
        '### The brief, as the marketer wrote it',
        '',
        '> ' + String(brief).trim().split('\n').join('\n> '),
        '',
        `Sent to **${system.label || system.id}**. ` +
        'Captured verbatim before any agent touched it, so every later stage can be ' +
        'read against what was actually asked for.'
    ].join('\n')
}

/**
 * The closing artifact: where the time went and what is unresolved.
 * The cookbook demo called this the time ledger, and it is the thing that
 * answers "why did this take two weeks" - so it is worth writing every run,
 * even when the answer is "it took four seconds".
 */
function narrateLedger (steps, opts = {}) {
    const total = steps.reduce((n, s) => n + (s.duration_ms || 0), 0)
    const faults = steps.filter(s => s.embedded_error)

    const lines = ['### Time ledger', '']
    lines.push('| Stage | Took | Reported | Actually |', '|---|---|---|---|')
    for (const s of steps) {
        lines.push(
            `| ${opts.labelFor ? opts.labelFor(s.agent_id) : s.agent_id} | ${seconds(s.duration_ms)} ` +
            `| ${s.upstream_status} | ${s.embedded_error ? '**faulted**' : s.upstream_status} |`
        )
    }
    lines.push('', `**Total agent time:** ${seconds(total)}.`, '')

    if (faults.length) {
        lines.push(
            `**${faults.length} stage${faults.length === 1 ? '' : 's'} reported success while failing.** ` +
            'A per-run view records this run as clean. Only reading across runs shows that the ' +
            'same tool has failed every time.',
            ''
        )
    } else {
        lines.push('No stage contradicted its own status this run.', '')
    }

    if (opts.settled === false) {
        lines.push('The pipeline had not finished when this was written. Call `get_intake` for the rest.', '')
    }
    return lines.join('\n')
}

module.exports = { narrateStep, narrateBrief, narrateLedger, seconds, workfrontUrl, findWorkfrontRefs }
