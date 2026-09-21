/*
Copyright 2026 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

/**
 * MCP Server Tools - the Resource Control Plane / company cookbook (D26, D30, D33)
 *
 * Host-neutral: no AI-vendor-specific code - any MCP client can call these tools.
 * Storage lives behind lib/store.js (see the // SWAP POINT there for a future backend swap).
 * The Resource Policy (config/resource-policy.json, lib/policy.js) is data, not code - it
 * declares what resource types ("job kinds") this connector accepts, their required
 * fields, formats, storage routing, and approval rules. save_resource enforces it;
 * get_resource_policy / list_resource_types let any AI learn it.
 *
 * Two dimensions organize every resource (D30/D33): its policy `type` (kind) and its
 * work context `epic -> story -> task` - so the cookbook is browsable by the unit of
 * work that produced a job, not just by kind. Work context is declared by the AI or
 * user (set_work_context / save_resource fields); an issue tracker can populate it
 * later without any coupling here.
 *
 * Everything is EXPERIMENTAL on capture and stays in the Test Kitchen until a human
 * certifies it (D38); only approved jobs enter the cookbook / MCP Resources. Jobs are
 * segmented per configurable levels (D39, default Project -> Epic -> Story; project required),
 * updated-in-place by stable id (version++ + history, not duplicated), carry a token counter
 * and an owner (D39/D40). handoff-prompt is exempt from cookbook approval (task_status lifecycle).
 *
 * Tools:
 * - get_resource_policy / list_resource_types - learn what kinds to capture and where
 * - get_segmentation_config - the ordered segmentation levels (Project/Epic/Story...)
 * - start_project      - start/select a Project + make it the active work context (D39)
 * - set_work_context   - set the active project + default segment levels for later saves
 * - save_resource      - contribute/UPDATE a job (policy-validated, routed, experimental
 *                        by default; upsert by stable id -> version++/history; tokens + owner)
 * - find_similar       - find existing jobs before saving, to update not duplicate
 * - approve_resource / certify - human-consent approval -> approved (records approved_by/at/note)
 * - export_as_skill    - turn an APPROVED job into a portable skill/prompt (D31)
 * - list_active_tasks / set_task_status / link_jobs - handoff-prompt task lifecycle (D36)
 * - list_resources     - discover jobs (metadata only), filter by project/kind/tag/status/epic/story/owner
 * - search_resources   - find jobs by keyword, same filters
 * - get_resource       - read a job's full content
 *
 * Also re-exposes captured resources as native MCP Resources (resources/list, resources/read,
 * a resource://company/{type}/{id} template) so any MCP client - not just the one that saved
 * it - can reuse company knowledge (extends D16).
 */

const { z } = require('zod')
const { randomUUID, createHash } = require('crypto')
const { ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js')
const store = require('../../lib/store')
const policy = require('../../lib/policy')
const skills = require('../../lib/skills')
const segmentation = require('../../lib/segmentation')
const statusLib = require('../../lib/status')
const stepsLib = require('../../lib/steps')
const retention = require('../../lib/retention')
const settings = require('../../lib/settings')
const usersLib = require('../../lib/auth/users')
const cxGraph = require('../../lib/cx-graph')
const agentSystems = require('../../lib/agent-systems')
const narrate = require('../../lib/narrate')
const mcpServers = require('../../lib/mcp-servers')
const mcpGateway = require('../../lib/mcp-gateway')
const approvalConfig = require('../../config/approval.json')

const TASK_STATUSES = ['open', 'in_progress', 'done']
const HANDOFF_TYPE = 'handoff-prompt'
/** Identity used when the caller authenticated with x-api-key (no per-user OIDC identity). */
const SERVICE_PRINCIPAL = 'service-account'
/** Material-change re-consent flag (D38); config, default true. */
const REAPPROVE_ON_CHANGE = approvalConfig.reapprove_on_change !== false

const POLICY_TYPE_IDS = policy.listTypeIds()
const SEGMENT_LEVEL_KEYS = segmentation.levelKeys()

/** @param {string} content @returns {string} short content hash for material-change detection */
function contentHash (content) {
    return createHash('sha256').update(String(content || ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * Resolve the authenticated principal (owner / approver identity). Falls back to
 * the service principal for the x-api-key path, which carries no per-user identity.
 * @param {{ userInfo?: object }} context
 * @returns {string}
 */
function resolvePrincipal (context) {
    const userInfo = context && context.userInfo
    if (!userInfo) return SERVICE_PRINCIPAL
    return userInfo.email || userInfo.username || userInfo.user_id || userInfo.sub || SERVICE_PRINCIPAL
}

/**
 * Seed roles carried by the caller's own credential (D79) - e.g. an API key mapped to a specific
 * entity. Additive only; settings.user_roles stays authoritative and admin-editable.
 * @param {{ userInfo?: object }} context
 * @returns {string[]}
 */
function credentialSeedRoles (context) {
    const roles = context && context.userInfo && context.userInfo.roles
    return Array.isArray(roles) ? roles : []
}

/**
 * The caller's full role set (D66/D79): stored roles + credential seed roles, then chef by
 * default - except `viewer`, which is exclusive and read-only.
 * @param {{ userInfo?: object }} context
 * @returns {string[]}
 */
function callerRoles (context) {
    return settings.rolesFor(resolvePrincipal(context), credentialSeedRoles(context))
}

/** @returns {boolean} whether the caller holds a given role (D66/D79) */
function callerHasRole (context, role) {
    return settings.hasRole(resolvePrincipal(context), role, credentialSeedRoles(context))
}

/**
 * May this caller see other people's SUBMITTED (baked) work? (D86)
 *
 * Head Chefs and admins must, because they cannot review a candidate they cannot open. Nobody else
 * does: a colleague's baked-but-not-yet-admitted job is still under review, not yet company
 * knowledge. Assignment is the separate, explicit route for sharing unfinished work.
 * @param {object} context
 * @returns {boolean}
 */
function callerCanReview (context) {
    return callerHasRole(context, 'head-chef') || callerHasRole(context, 'admin')
}

/**
 * May this caller READ this resource? (D88)
 *
 * The same four rules the store applies when listing: your own work, work admitted to the CX
 * graph, work submitted for review if you are a reviewer, and work explicitly assigned to you.
 *
 * This exists because filtering the LIST was not enough. Every read-by-id path went straight to
 * storage, so a colleague's private draft was one predictable id away: ids are
 * `job-<timestamp>-<slug-of-title>`, and get_resource / get_job / list_steps returned the
 * whole thing. Enforcing privacy only on enumeration makes it decorative.
 *
 * @param {object} resource full resource
 * @param {object} context caller identity
 * @returns {boolean}
 */
function callerCanRead (resource, context) {
    if (!resource) return false
    // A handoff-prompt is a brief addressed to someone else by design, and auto-approves on
    // capture; it is not private working content.
    if (resource.type === HANDOFF_TYPE) return true
    const me = resolvePrincipal(context)
    if (resource.owner === me || resource.author === me) return true
    if (resource.cx_approved === true) return true
    if ((resource.assigned_to || []).includes(me)) return true
    if (resource.baked === true && callerCanReview(context)) return true
    return false
}

/**
 * Whether the caller may CHANGE this resource. D88 and D99 closed the read paths, and every
 * mutation was then gated on callerCanRead - which is the wrong rule, because reading and
 * writing are not the same permission. callerCanRead says yes to anything in the CX graph, so
 * everyone could edit the shared jobs nobody owns; and save_resource had no gate at all, so
 * a peer who knew an id could overwrite a colleague's private draft, take its authorship (owner
 * was reassigned to the caller unconditionally), and leave the real author unable to read their
 * own work. Sharing something to be read is not consent to have it rewritten.
 *
 * Writing is the narrow rule: your own work, or an ingredient someone deliberately assigned you.
 * Reviewers are deliberately absent - their power is headchef_approve / headchef_reject / assign,
 * not editing the thing they are judging.
 *
 * @param {object} resource full resource
 * @param {object} context caller identity
 * @returns {boolean}
 */
function callerCanWrite (resource, context) {
    if (!resource) return false
    const me = resolvePrincipal(context)
    if (resource.owner === me || resource.author === me) return true
    if ((resource.assigned_to || []).includes(me)) return true
    return false
}

/** The single refusal for a write the caller does not own. */
function notWritableError (id) {
    return errorResult(`Refused: '${id}' is not yours to change. You may change your own jobs, and ones where its author has assigned you an ingredient. If you need to work on this, ask its author to assign you an ingredient with assign_step. If you are reviewing it, use headchef_approve or headchef_reject.`)
}

/** The single refusal message, so every read path says the same thing. */
function notVisibleError (id) {
    return errorResult(`No resource visible to you with id '${id}'. It may not exist, or it may be someone else's unfinished work: a job becomes readable when its author bakes it and a Head Chef admits it, or when they assign you one of its ingredients.`)
}

/**
 * Every state-changing tool (D79). Used for ONE read-only choke point rather than a guard
 * duplicated into ~20 handlers, so a newly added write tool cannot accidentally bypass the
 * `viewer` restriction - anything not listed here is treated as a read, and the list is asserted
 * against the live registration set in tests.
 */
const WRITE_TOOLS = new Set([
    'save_resource', 'start_project', 'start_job', 'append_step', 'set_work_context',
    'approve_resource', 'certify', 'approve_step', 'approve_steps', 'discard_step',
    'bake_job', 'bake_project', 'set_project_status', 'set_task_status', 'link_jobs',
    'update_settings', 'set_head_chefs', 'set_user_roles', 'set_practices', 'set_user_practices',
    'headchef_approve', 'headchef_reject',
    'rebuild_cx_graph', 'purge_expired', 'admin_reset_data',
    'create_user', 'set_user_password', 'set_user_enabled', 'change_my_password', 'delete_job', 'assign_step', 'unassign_step', 'set_user_display_name',
    // Starts a run upstream AND writes the captured run here.
    'start_intake',
    /*
     * Opens the gate at 1.5, which makes the pipeline run agents and write to
     * Workfront. As state-changing as anything on this server: a reader able to
     * call these could send a campaign into the audience build.
     *
     * The D79 guard test caught this being absent, which is exactly what it is
     * for - the gate is only as good as its completeness.
     */
    'approve_intake', 'reject_intake', 'answer_intake', 'continue_job',
    /*
     * preview_intake is deliberately NOT in this set, and used to be.
     *
     * It creates nothing - no Workfront object, no run, no mail. It exists so
     * a marketer can see what WOULD be filed while it is still free to change.
     * Gating it behind the write guard meant a read-only viewer, the identity
     * that most needs to look without touching, was refused the one operation
     * that cannot touch anything - and told to go and ask for more access in
     * order to preview.
     *
     * It had been appended to the line above, whose comment justifies the
     * entries by "opens the gate at 1.5, which makes the pipeline run agents
     * and write to Workfront". That reasoning never applied to a preview.
     *
     * The D79 guard matches names beginning save|start|append|approve|... so
     * it never covered this either way. Removing it refuses nothing that
     * changes data.
     */
    // Changes which MCP servers agents can reach, and which upstreams execute them.
    'set_mcp_server', 'set_agent_system'
])

/**
 * What a connected AI is told this server is for (MCP `initialize` instructions).
 *
 * THE SINGLE MOST IMPORTANT THING IN THIS FILE, and the one that was wrong the
 * longest.
 *
 * This service was built on the company cookbook's engine, and it inherited the
 * cookbook's instructions unchanged. Those instructions tell any client that
 * connects: "whenever you produce an artifact - a diagram, an architecture doc,
 * some code - capture it here." That is correct for a cookbook. It is wrong
 * here, and it is not a cosmetic wrongness: a connected Claude Desktop read
 * them and started uploading architecture diagrams from an unrelated
 * conversation into Agent Manager, because that is exactly what it had been
 * asked to do. Replacing the client's own system prompt did not help, and could
 * not have - these instructions are served by the server, over MCP, and they
 * arrive after the system prompt and describe the tools being offered.
 *
 * Agent Manager records what the AGENT PIPELINE did. Its runs come from
 * start_intake, not from an assistant deciding its own output is worth keeping.
 * So these instructions say what the tools are for, and say plainly what NOT to
 * send - because a tool called append_step on a server that used to be a
 * cookbook will otherwise be used like a cookbook.
 */
const SERVER_INSTRUCTIONS = `This is CX Agent Manager: the record of what Comcast's Workfront
creative-intake AGENTS did, across runs, and the gateway to the agent systems themselves.

IT IS NOT A PLACE TO FILE YOUR OWN WORK. Do not capture diagrams, architecture
documents, code, notes or summaries you produced in conversation here. That belongs in
the company cookbook, which is a different server. If you are about to call append_step or
save_resource to store something YOU made rather than something an AGENT produced, stop:
you have the wrong server. This one has runs in it, not artifacts you wrote.

WHAT IT IS FOR

1. Seeing the agent estate. call list_agent_systems for the pipelines wired in, and
   list_system_agents for the agents inside one. The list is read from each system's own
   catalog at call time, so an agent added upstream appears here without a deploy. Never
   hardcode an agent name; ask.

2. Running an intake. start_intake({brief}) sends a marketer's brief to the pipeline and
   records the whole run: the brief verbatim, one artifact per agent stage, and a time
   ledger. get_intake reads one back. The run is created BY the pipeline running - you do
   not assemble it yourself, and you should not append to it to "complete" it.

3. Reading across runs. list_jobs / get_job / search_resources answer "has this
   failed before", which no single run can. That is the whole point of the layer: one run
   looks fine, ten runs show the same tool failing every time.

4. Managing MCP servers. list_mcp_servers, set_mcp_server and check_mcp_server register and
   verify the Adobe MCP endpoints (Workfront, AEP, AEM) that agents reach through. Adding a
   server is configuration, never code.

5. Moving a run past the approval at 1.5. approve_intake / reject_intake. See below, because
   this is the one thing on this server that is easy to get wrong.

A BRIEF IS A REQUEST TO FILE IT. FILE IT.

When someone gives you a brief and asks to start an intake, call start_intake with it.
That is the FIRST tool call, and there is no research phase in front of it. Do not
search for similar past work, do not read files off the machine you are running on,
do not open a subagent to summarise or investigate anything, and do not go looking
for an older run with the same words in it. None of that answers what was asked, and
all of it runs while a marketer sits waiting and nothing has been filed.

If another server you are connected to told you to search for prior work before
starting anything: that rule is for a knowledge store, and it does not apply here.
Filing an intake is not rebuilding something the company already has. It is a new
request from a person who is in front of you.

A BRIEF THAT LOOKS LIKE YESTERDAY'S IS STILL A NEW REQUEST.

Two campaigns can share every word of their brief and still be two campaigns. The
marketer knows which one they are filing; you cannot. So do not refuse an intake, or
decline to start one, because an existing run resembles it - there is no "one run per
brief" rule, and inventing one leaves the person with nothing filed and no way to
argue with you. If you think they may be re-filing by mistake, FILE IT and say what
you noticed in the same message.

The rule further down about not calling start_intake twice is narrower than it
sounds: it is about a run IN FRONT OF YOU that came back needs_input, which you
answer with answer_intake instead of starting again. That is all it is about.

THE AGENTS ARE UPSTREAM. A SUBAGENT YOU OPEN IS NOT ONE OF THEM.

The agents in this process are the ones list_system_agents names. They live in the
harness, they are the only things that read a brief, and they are the only agents a
marketer's run should involve. So:

  - Never open a subagent, task or worker of your own to do a stage's work, to
    summarise a run, or to look into one. Everything about a run comes back from
    get_intake or get_job in a single call.
  - Reading fifty files to describe a job that get_intake returns whole is not
    thoroughness. It is a detour, and the marketer is at the end of it.

For scale: the pipeline's own compute is SECONDS - a brief stage is typically one to
twenty. A run's wall-clock is long only where it is waiting on a person: a
needs_input answer, or the named approval in Workfront. So if a marketer is waiting
minutes and no stage has run, the time is not the pipeline's. It is being spent
before the first tool call.

YOU REPORT THIS PROCESS. YOU DO NOT DECIDE IT.

The steps, their order and the points where the work waits are fixed by the
harness. They are not yours to interpret, shorten, or route around, and the
right behaviour when something is missing or odd is to SAY SO and stop - not to
offer the person a way past it.

Specifically:

- Do not ask the person whether to proceed past a point where the process waits.
  It waits on a named thing happening elsewhere, not on their permission for you
  to continue. Offering "approve and continue, or reject and fix it?" invents a
  decision that is not in the process, and the answer to it has already been
  mistaken once for a Workfront approval that had not happened.
- Do not describe an agent's output in terms of what you would have done. Report
  what it reported, including the parts that read badly.
- Do not fill a gap in what you can see with an inference. "I could not read
  stage 2's output" is a complete and useful answer; guessing from a previous
  job is not.
- Do not use our internal step numbers with anyone. They are in the tool
  descriptions to tell YOU where you are. A marketer has never heard of 2.1 and
  should be told "the request has been turned into a project", not a coordinate.

THE WORD "APPROVE" MEANS TWO DIFFERENT THINGS HERE. READ THIS.

There are two approvals and they are unrelated. Getting them the wrong way round has already
produced a wrong outcome: a person said "approved 6aac001e..." naming a Workfront ticket, the
job was certified into Playbooks, and the run went on sitting at awaiting_approval with
Agent 2 never invoked. The campaign did not move. Nothing reported an error.

  approve_intake / reject_intake   A decision about THIS REQUEST, at step 1.5 of the
                                   process. It opens the gate so Agent 2 runs and the
                                   campaign proceeds. THIS is what someone means when they
                                   say a brief or a ticket is approved.

  approve_step / bake_job /     A decision about the RECORD of a run - whether it is
  certify                          worth keeping as knowledge, and whether the Oracle
                                   may learn from it. It changes NOTHING about whether the
                                   campaign proceeds.

How to tell which one is meant:

  - A Workfront object id, a ticket, a brief, a request -> approve_intake.
  - A run sitting at awaiting_approval -> approve_intake. Nothing else moves it.
  - The words "certify", "playbooks", "knowledge", "worth keeping" -> the job path.
  - Genuinely unsure -> ask. "Do you mean approve the request so it moves to the audience
    build, or approve the record of this run for Playbooks?" is one short question and it
    is cheaper than either mistake.

approve_intake takes the Workfront id directly, so you do not need to make anyone look up a
run id for something they have already approved.

Neither tool approves anything INSIDE Workfront. A named person clicks Approve in
Workfront's own Approvals tab; approve_intake records that they did so the pipeline can
move. Do not claim to have approved a Workfront object.

WHY A RUN MAY SHOW FEWER STAGES THAN YOU EXPECT

An agent behind a closed gate is not called and writes no stage at all. So a run with one
stage is normal and means "waiting", not "broken" and not "lost". get_intake returns a
waiting_for field saying which decision is outstanding - report that, and do not describe
the missing stages as having failed or as having been skipped.

ANSWERING A QUESTION IS NOT STARTING A NEW JOB.

This is about a run you are already holding, not about a new brief that resembles an
old one - see "A BRIEF THAT LOOKS LIKE YESTERDAY'S" above, because this section has
already been read as a reason to refuse a fresh intake.

When a job comes back needs_input, answer it with answer_intake. Do NOT call
start_intake again with a completed or corrected brief - that creates a second
job for the same work, with a second Workfront request behind it, and leaves two
identical-looking rows on the bench with nobody able to say which is real. It
also destroys the only number that says whether the agent is doing its job: B1
measures health by how many rounds a brief takes, and rounds spread across
separate records cannot be counted.

DO NOT TIDY UP. RETRIES ARE THE DATA.

If start_intake comes back needs_input, do not delete the run and try again with different
wording. Answer the question it asked, or tell the person what it asked for. Every attempt
stays.

This has already gone wrong: a brief was submitted, returned needs_input twice, was
rephrased until it passed, and the two failed attempts were then deleted "so you are not
left with junk runs". What that produced was a store containing one clean run and no trace
of a parser that had just failed twice. B1 measures agent health by the number of rounds a
brief takes - "more than two rounds means the agent failed, not the marketer" - so the
failed attempts are the measurement. Deleting them reports a success that did not happen.

delete_job now refuses agent runs for this reason. Do not force past it to clean up;
force is for when a human has explicitly told you to remove a run.

WHAT TO DO ABOUT A FAULTED RUN

A stage that returns "completed" while the tool it called failed is the known failure in
this pipeline, and it is why nothing downstream ever escalates. When you read a run, say so
plainly - "reported completed, actually faulted" - and do not summarise it as a success
because its status field says so. Repeating the status is repeating the lie.

CAPTURE THAT IS WELCOME HERE

Only things about a run that already exists:
  - append_step with kind:"steering" and a signal (affirm/reject/correct) to record how a
    human steered or corrected a run. Corrections are the most valuable thing in here.
  - approve_step / approve_steps to mark the parts of a run worth keeping, then bake_job
    to hand the run to the Oracle, which reads it against every earlier run and
    PROPOSES what should be learned. A named human always decides; the Oracle never
    admits anything to the CX Agentic Graph by itself.
    These are about the RECORD. If someone wants the campaign to proceed, they want
    approve_intake instead - see the section above.

ALWAYS report provenance on anything you do write: model, tokens_used, and source (which
client you are, e.g. "desktop-ai", "ide-agent"). An omitted tokens_used is recorded as "not
reported", never as zero, and shows in the dashboard as missing telemetry.

THE APPROVAL IS NOT YOURS TO GIVE

A request waits for a named person to click Approve inside Workfront. That is a
manual step, on purpose, and it is the one place in this pipeline where a human
decision is load-bearing: everything downstream - the project, the audience, the
spend - proceeds on the strength of it.

So when a job is waiting for approval, do not offer to approve it, do not ask
whether the person wants you to, and do not present "approve and continue
anyway" as an option. There is no version of that which is correct. Say what was
created, give the Workfront link, say it needs their approval there, and stop.

approve_intake exists to RECORD an approval that already happened. It reads the
record back from Workfront and refuses unless Workfront itself reports the
approval has cleared - so offering to approve does not just misrepresent your
role, it proposes something that will fail.

The same goes for rejecting.

WRITING A COMMENT INTO WORKFRONT

Two rules, both learned the hard way on a live tenant.

PLAIN TEXT ONLY. Workfront's comment stream is not an HTML field. A comment sent as
"<p><strong>Correction to the intake capture:</strong>..." rendered with the tags visible,
on one line, in the middle of a thread real people were reading. No markdown either - no
**bold**, no bullets with "*". Line breaks work; nothing else does.

SAY WHICH AGENT WROTE IT. The tenant holds ONE Adobe token, so every comment this gateway
writes shows the name of whoever authenticated the server - a real employee - on comments no
human typed. A reviewer then replies to a colleague who never wrote it, and the audit trail
records a person asserting what an agent asserted. So open the comment with the agent that
produced the content, e.g. "Agent 1 - Intake (automated)", and say plainly that it was
posted by the pipeline. If the content is yours rather than an agent's, say that instead;
do not borrow an agent's name for your own correction.

Never put internal step numbers - 1.5, 2.1, 2.7 - in anything a marketer or reviewer reads.
They are coordinates on our process map and mean nothing to them. Say what happened.

HANDING WORK TO ANOTHER TOOL

When you write a prompt meant for another agent or coding tool, save it as a
"handoff-prompt" with target_agent set, and job_id set to the run it belongs to. It then
appears in the Live Queue as an open task, can be picked up outside this chat, and is marked
in_progress/done with set_task_status. That is a pointer to work, not an artifact you made,
which is why it belongs here and a diagram does not.

Work is organised by programme. Call start_project at the beginning of an unrelated piece of
work, or set_work_context to move into an existing one, so runs do not pile into one shared
programme. The configured segmentation levels are ${SEGMENT_LEVEL_KEYS.join(' -> ')} (call
get_segmentation_config for the labels).`

/*
 * Words that carry no distinguishing power in a campaign brief. Without this,
 * "the" and "for" make every brief look like every other brief.
 */
const BRIEF_STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'we', 'our', 'is', 'it',
    'with', 'this', 'that', 'from', 'by', 'at', 'as', 'be', 'are', 'need', 'want', 'hey',
    'just', 'going', 'after', 'there', 'want', 'audience', 'campaign', 'push', 'customers'
])

/** The words worth comparing two briefs on. */
function briefTerms (text) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .split(/[^a-z0-9$]+/)
            .filter(w => w.length > 2 && !BRIEF_STOPWORDS.has(w))
    )
}

/**
 * Runs that look like this one, and what differs.
 *
 * WHY THIS IS THE POINT OF THE WHOLE LAYER
 *
 * A connected Claude read five runs of ours and noticed, unprompted, that four
 * earlier "Fall Switch and Save / Northeast HSD without mobile" runs carried a
 * $600 prepaid card and the newest carried $350 - and asked whether the offer
 * had changed or the numbers had got crossed. That is exactly the question a
 * cross-run record exists to raise, and it was raised by a person reading
 * carefully rather than by the thing built to raise it.
 *
 * So: on every intake, look for briefs that overlap heavily and report the
 * NUMBERS THAT DIFFER between them. Numbers are where this goes wrong - an
 * offer, a card value, a count - and two briefs that agree on every word except
 * a figure are either a deliberate revision or a mistake, and only a human can
 * say which.
 *
 * It reports; it never blocks. A revised offer is a completely legitimate reason
 * for two similar briefs to exist.
 */
/**
 * Prior work worth reusing, and near-duplicates worth a second look.
 *
 * THESE ARE TWO DIFFERENT QUESTIONS AND THEY USED TO BE ONE.
 *
 * This searched every stored run, experimental ones included, and offered them
 * as prior work. On a real brief that produced: "this exact brief was already
 * raised - three times today" and a recommendation to reuse a run in which
 * Agent 3 had built nothing and Agent 2 had swallowed a failed tool call. An
 * unapproved run is not knowledge. It is a thing that happened, and most of
 * what happens in a pipeline like this is what we are trying to stop happening.
 *
 * So:
 *
 *   `similar` (REUSABLE)   approved runs only - the CX Agentic Graph. A
 *                          human certified these, which is exactly what makes
 *                          them safe to build on.
 *   `duplicates` (CAUTION) unapproved runs that look like this brief. NOT
 *                          offered as prior work. They answer a different and
 *                          still-useful question: "are you about to raise a
 *                          fourth Workfront ticket for this?"
 *
 * Conflating them meant the caution was dressed up as a recommendation.
 */
async function findSimilarRuns (brief, project, context) {
    const terms = briefTerms(brief)
    if (terms.size < 3) return { similar: [], duplicates: [] }

    const entries = await store.listResources({
        visibleTo: resolvePrincipal(context),
        visibleSubmitted: callerCanReview(context)
    }).catch(() => [])

    const money = (text) => [...new Set(String(text || '').match(/\$\s?\d[\d,]*|\b\d[\d,]*\s*(?:dollar|usd)s?\b/gi) || [])]
    const mine = money(brief)

    const similar = []
    const duplicates = []
    for (const entry of entries) {
        if (!entry.upstream) continue
        if (project && entry.project && entry.project !== project) continue
        // Older runs predate the stored brief; the title is a weaker but real
        // fallback rather than skipping them entirely.
        const otherText = entry.brief || entry.title
        const other = briefTerms(otherText)
        if (!other.size) continue

        let shared = 0
        for (const t of terms) if (other.has(t)) shared++
        // Jaccard against the smaller set, so a short title is not penalised.
        const overlap = shared / Math.min(terms.size, other.size)
        if (overlap < 0.55) continue

        const theirs = money(otherText)
        const differing = mine.filter(m => theirs.length && !theirs.includes(m))
            .concat(theirs.filter(t => mine.length && !mine.includes(t)))

        const row = {
            job_id: entry.id,
            title: entry.title,
            created: entry.created,
            overlap: Math.round(overlap * 100) / 100,
            // The thing worth a second look.
            differing_figures: [...new Set(differing)],
            agents: entry.agents || [],
            faulted: entry.agent_faults || []
        }

        if (statusLib.isApproved(entry.status)) similar.push(row)
        else duplicates.push({ ...row, status: 'experimental' })
    }
    similar.sort((a, b) => b.overlap - a.overlap)
    duplicates.sort((a, b) => b.overlap - a.overlap)
    return { similar: similar.slice(0, 5), duplicates: duplicates.slice(0, 5) }
}

/*
 * Workfront's own approval records, as CODES.
 *
 * `redrock_approverStatus` is the approver-status record behind every approval:
 * one row per approver per stage, carrying `approvableObjCode` /
 * `approvableObjID` and a status of AD (Approved), RJ (Rejected), AA (Awaiting
 * Approval) or NA (Not Available). It is the thing Workfront itself decides
 * from, so it is what this asks.
 *
 * The condition argument is `condition`, an and/or node wrapping a `conditions`
 * array of `{fieldId, operator, values}`. Passing a bare clause, or calling the
 * argument `filters`, is accepted and then SILENTLY IGNORED - the query returns
 * every row in the tenant and the first one looks like an answer. That is worth
 * knowing, because it fails by returning plausible data rather than an error.
 */
const APPROVER = 'redrock_approverStatus'
const approverField = (f) => `${APPROVER}.${APPROVER}_${f}`

/**
 * One approver row's verdict, from either the code or its display name.
 *
 * find_workfront_data hands back display names ("Awaiting Approval") while the
 * field metadata lists codes ("AA"), so both are accepted rather than betting
 * on which surface a given tenant or version returns.
 *
 * @param {string} raw
 * @returns {'approved'|'rejected'|'pending'|'none'}
 */
function approverVerdict (raw) {
    const v = String(raw == null ? '' : raw).trim().toLowerCase()
    if (v === 'ad' || v === 'approved') return 'approved'
    if (v === 'rj' || v === 'rejected') return 'rejected'
    if (v === 'aa' || v === 'awaiting approval') return 'pending'
    return 'none'
}

/**
 * Is this object approved, according to Workfront's approval records?
 *
 * Returns null when there is nothing structured to go on - no rows, or the
 * query could not be run - so the caller falls back to reading the object
 * summary. An object approved by a plain status change, with no approval
 * process attached, has no rows at all, and that case is real.
 *
 * @param {string} objCode
 * @param {string} objId
 * @returns {Promise<{approved: boolean, status: string, detail: string}|null>}
 */
async function structuredApprovalState (objCode, objId) {
    let data
    try {
        data = await mcpGateway.callProxied(
            'workfront-adobe__insights_find_workfront_data',
            {
                field_paths: [
                    { field_id: approverField('status') },
                    { field_id: approverField('approvableObjCode') },
                    { field_id: approverField('approvableObjID') },
                    { field_id: approverField('approvedByID') }
                ],
                condition: {
                    operator: 'and',
                    conditions: [
                        { fieldId: approverField('approvableObjID'), operator: 'eq', values: [String(objId)] }
                    ]
                },
                limit: 100
            },
            settings.mcpServers()
        )
    } catch (e) {
        return null
    }

    const payload = (typeof data === 'string') ? (() => { try { return JSON.parse(data) } catch (e) { return null } })() : data
    const rows = (payload && Array.isArray(payload.rows)) ? payload.rows : null
    if (!rows || !rows.length) return null

    /*
     * Only rows for the object actually asked about. If the condition were ever
     * ignored again - a renamed argument, a version change - this is what stops
     * another object's approval being read as this one's.
     */
    const mine = rows.filter(r => {
        const cell = r[approverField('approvableObjID')]
        return cell && String(cell.value).toLowerCase() === String(objId).toLowerCase()
    })
    if (!mine.length) return null

    const verdicts = mine.map(r => {
        const cell = r[approverField('status')]
        return approverVerdict(cell && cell.value)
    })

    /*
     * PENDING BEATS REJECTED BEATS APPROVED, and the order is deliberate.
     *
     * There is no timestamp on an approver-status record, so where a row says
     * one thing and another says the opposite, they cannot be put in order.
     * Reading that as approved is the failure that matters - a campaign
     * proceeding on an approval nobody gave - so the pessimistic reading wins.
     * A stale rejection at worst sends someone to look at Workfront, which is
     * where the answer is anyway.
     */
    const n = (v) => verdicts.filter(x => x === v).length
    if (n('pending')) {
        return {
            approved: false,
            status: 'AA',
            detail: `Workfront's approval records show ${n('pending')} approver(s) still to respond.`
        }
    }
    if (n('rejected')) {
        return {
            approved: false,
            status: 'RJ',
            detail: "Workfront's approval records show a REJECTION against this request."
        }
    }
    if (n('approved')) {
        return {
            approved: true,
            status: 'AD',
            detail: `Workfront's approval records show it approved (${n('approved')} of ${mine.length} approver rows).`
        }
    }

    // Every row is "Not Available": stages exist but nobody has acted.
    return {
        approved: false,
        status: 'NA',
        detail: "Workfront has approval stages on this request but no approver has recorded a decision."
    }
}

/**
 * Is this Workfront record actually approved, according to Workfront?
 *
 * Asks Workfront's approval records first, because they are codes. Only when
 * there are none - an object approved by a status change with no approval
 * process attached - does it fall back to reading the object summary, which is
 * PROSE, and prose is why this check used to be intermittent: it was grepped
 * for the literal phrase "approved this", assumed the update log was
 * newest-first, and quietly reported "never approved" whenever the summary was
 * worded differently, ordered differently or truncated.
 *
 * Returns a tri-state, and the middle one matters most: `null` means the check
 * could not be performed, and the caller treats that as NOT approved. Failing
 * open here would restore exactly the hole this closes, because the easiest way
 * to get a false approval past a checker is to break the checker.
 */
async function workfrontApprovalState (objCode, objId) {
    const structured = await structuredApprovalState(objCode, objId)
    if (structured) return { ...structured, url: workfrontLink(objCode, objId) }

    const entity = objCode === 'PROJ' ? 'project' : 'issue'
    let summary
    try {
        summary = await mcpGateway.callProxied(
            'workfront-adobe__insights_summarize_object',
            {
                entity,
                object_id: objId,
                intent: 'Check whether this intake request has actually been approved before letting the pipeline continue.'
            },
            settings.mcpServers()
        )
    } catch (e) {
        return { approved: null, status: null, detail: `Workfront could not be read: ${e.message}` }
    }

    const markdown = (summary && typeof summary === 'object' && typeof summary.markdown === 'string')
        ? summary.markdown
        : (typeof summary === 'string' ? summary : JSON.stringify(summary || {}))

    const status = (markdown.match(/\*\*Status\*\*:\s*([A-Z]{2,4}(?::[A-Z])?)/) || [])[1] || null
    // Workfront hands back its own deep link. Preferred over building one,
    // because it is right even if our tenant configuration is not.
    const url = (markdown.match(/\]\((https:\/\/[^)\s]+)\)/) || [])[1] || null

    /*
     * The update log, newest first. The FIRST line that speaks to approval is
     * the current state; earlier lines are history.
     */
    const events = markdown.split('\n').filter(l => /approved this|submitted this to approval|rejected this/i.test(l))
    const latest = events[0] || null

    if (latest && /rejected this/i.test(latest)) {
        return { approved: false, status, url, detail: `Workfront records a REJECTION: ${latest.trim()}` }
    }
    if (latest && /approved this/i.test(latest)) {
        return { approved: true, status, url, detail: `Workfront records the approval: ${latest.trim()}` }
    }
    if (/:A$/.test(status || '') || (latest && /submitted this to approval/i.test(latest))) {
        return {
            approved: false,
            status,
            url,
            detail: `Workfront reports "${status}" - submitted for approval and still waiting on an approver.`
        }
    }

    /*
     * No approval history at all. NOT approved, and the distinction matters:
     * this is a request nobody has put into approval yet, which is the normal
     * state of one an agent created a moment ago.
     */
    return {
        approved: false,
        status,
        url,
        detail:
            `Workfront reports "${status}" and its update log records no approval at all - this request ` +
            'has not been submitted for approval yet, let alone approved.'
    }
}

/**
 * A link to the record, so "go and approve it" names a place.
 *
 * Built from whichever Workfront MCP server is registered, so the tenant
 * follows the configuration rather than being written in here.
 */
function workfrontLink (objCode, objId) {
    const servers = mcpServers.list(settings.mcpServers())
    const wf = servers.find(x => x.practice === 'workfront' && x.instance) || servers.find(x => x.instance)
    return wf ? narrate.workfrontUrl(objCode, objId, wf.instance) : null
}

/**
 * The run a Workfront object belongs to.
 *
 * Checks the rolled-up catalog first, which covers every run captured since
 * workfront_refs existed. Runs captured before it fall back to a scan of their
 * own artifacts - slower, and it means an older run is still addressable by the
 * id on its ticket rather than being unreachable because of when it was made.
 */
async function findRunByWorkfrontId (objId, context) {
    const wanted = String(objId || '').trim().toLowerCase()
    if (!wanted) return null

    /*
     * WHICH RUN CREATED A WORKFRONT OBJECT IS A FACT ABOUT THE SYSTEM, NOT
     * ABOUT THE CALLER.
     *
     * This used to list through the caller's visibility, and that is the second
     * reason approving was intermittent: the store held seventeen runs and a
     * service-key caller could see one, so approve_intake answered "no run in
     * Agent Manager created Workfront object X" for a run that plainly had.
     * Same request, same Workfront state, different answer depending on who
     * asked - which is the definition of the flakiness this is fixing.
     *
     * Unscoping it leaks nothing. The caller must already hold the Workfront id
     * to ask, all they get back is an internal run id, and the decision that id
     * unlocks is independently verified against Workfront before anything is
     * recorded. Visibility still governs what jobs a person can LIST and READ;
     * it has no business deciding whether a fact is true.
     */
    const entries = await store.listResources({}).catch(() => [])
    const runs = entries.filter(e => e.upstream)

    for (const e of runs) {
        const refs = e.workfront_refs || []
        if (refs.some(r => String(r.objId).toLowerCase() === wanted)) return e.id
    }

    // Older runs, projected before the rollup existed.
    for (const e of runs) {
        if (e.workfront_refs) continue
        const full = await store.getResource(e.id).catch(() => null)
        if (!full) continue
        for (const st of (full.steps || [])) {
            const payload = st.provenance && st.provenance.upstream_payload
            if (!payload) continue
            if (narrate.findWorkfrontRefs(payload.output)
                .some(r => String(r.objId).toLowerCase() === wanted)) return e.id
        }
    }

    /*
     * LAST, ASK THE PIPELINES WHAT THEY CREATED.
     *
     * Six of the seventeen runs in the store carry no workfront_refs at all,
     * although several of them plainly created a request - capture can miss the
     * attempt that did the work, which is exactly what recordGateDecision found
     * on the Pennsylvania run and already works around. Doing it there but not
     * here meant a job could be approvable once found and unfindable in the
     * first place.
     *
     * This is the slow path and it runs only when the two cheap ones found
     * nothing, so the common case is unaffected.
     */
    for (const e of runs) {
        const up = e.upstream
        if (!up || !up.run_id) continue
        try {
            const { system } = agentSystems.resolve(up.system_id, undefined, settings.agentSystems())
            if (!system) continue
            const upstream = await agentSystems.getRun(system, up.run_id)
            for (const st of agentSystems.toSteps(upstream)) {
                if (narrate.findWorkfrontRefs(st.output)
                    .some(r => String(r.objId).toLowerCase() === wanted)) return e.id
            }
        } catch (err) {
            // An unreachable pipeline is not evidence either way; keep looking.
        }
    }
    return null
}

/**
 * Resolve the contributing author from the caller's IMS identity, if present.
 * @param {{ userInfo?: object }} context
 * @returns {string}
 */
function resolveAuthor (context) {
    const userInfo = context && context.userInfo
    if (!userInfo) return 'unknown'
    // IMS userinfo scope determines which fields are present: a full-profile
    // token has email/name/user_id, a minimal-scope token (e.g. CLI login) may
    // only carry the opaque `sub` claim - still a real identity, just not human-readable.
    return userInfo.email || userInfo.username || userInfo.user_id || userInfo.sub || 'unknown'
}

/**
 * Build a readable, unique resource id: `${type}-${timestamp}-${slug}`.
 * @param {string} type
 * @param {string} title
 * @returns {string}
 */
function makeResourceId (type, title) {
    const slug = String(title)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || randomUUID().slice(0, 8)
    return `${type}-${Date.now()}-${slug}`
}

/**
 * @param {object} value
 * @returns {{ content: Array<{type: 'text', text: string}> }}
 */
function jsonResult (value) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(value, null, 2)
            }
        ]
    }
}

/**
 * @param {string} message
 * @returns {{ content: Array<{type: 'text', text: string}>, isError: true }}
 */
function errorResult (message) {
    return {
        content: [
            {
                type: 'text',
                text: message
            }
        ],
        isError: true
    }
}

/**
 * Recompute a job's flat projection from its steps (D45/D47) and attach the steps.
 * `status` is step-derived (experimental/approved) UNLESS the job has been baked
 * (D47), in which case `baked` is the source of truth and status shows "baked" - which
 * canonicalizes to "approved" for cookbook/MCP-resource exposure, so a baked job stays
 * visible even if a later experimental step or a retention purge would otherwise recompute
 * it. Timestamps are only touched when `now` is passed (save_resource preserves its own).
 * @param {object} resource
 * @param {object[]} steps
 * @param {string} [now] ISO timestamp; when given, updates updated/updated_at
 */
function projectJob (resource, steps, now) {
    resource.steps = steps
    resource.status = resource.baked ? 'baked' : stepsLib.jobStatusFromSteps(steps)
    resource.content = stepsLib.composeContent(steps)
    const tokens = stepsLib.aggregateTokens(steps)
    resource.tokens_used = tokens.total
    resource.tokens_last = tokens.last
    resource.models_used = stepsLib.aggregateModels(steps)
    resource.step_count = steps.filter(s => s.status !== 'discarded').length
    resource.expires_at = stepsLib.earliestExpiry(steps) // earliest experimental-step expiry (D48 Home/Work Log lens)
    // D86: everyone assigned on any live ingredient. Rolled up to the job because visibility is
    // decided from the catalog, and a discarded ingredient must not keep granting access.
    const assignees = new Set()
    for (const s of steps) {
        if (s.status === 'discarded') continue
        for (const a of (s.assigned_to || [])) if (a) assignees.add(a)
    }
    resource.assigned_to = assignees.size ? [...assignees] : undefined
    /*
     * Which agents touched this run, rolled up from its artifacts.
     *
     * The catalog is what every list view reads, and it carried no trace of the
     * agents at all - so "which runs has the review agent worked on" and "what
     * stage is this run on" were unanswerable without loading every job and
     * its steps. A rollup, exactly like models_used: derived, never authored.
     *
     * The artifact tags an agent step as ['agent', <id>] and adds
     * 'silent-failure' when the stage reported success while its tool call
     * failed. Both are kept, because a run where every stage "completed" and
     * two of them faulted is not the same run as one that actually worked, and
     * a progress bar that cannot tell them apart repeats the original lie.
     */
    const agentsSeen = []
    const faulted = new Set()
    for (const s of steps) {
        if (s.status === 'discarded') continue
        const tags = s.tags || []
        const at = tags.indexOf('agent')
        if (at === -1) continue
        const agentId = tags[at + 1]
        if (!agentId || agentId === 'silent-failure') continue
        if (!agentsSeen.includes(agentId)) agentsSeen.push(agentId)
        if (tags.includes('silent-failure')) faulted.add(agentId)
    }
    // Order is the order they ran, which is the order the artifacts were
    // appended - not alphabetical, and not the registry's order.
    resource.agents = agentsSeen.length ? agentsSeen : undefined
    resource.agent_faults = faulted.size ? [...faulted] : undefined

    /*
     * Every Workfront object this run created, rolled up for lookup.
     *
     * A person approves a ticket in Workfront and then says "approved
     * 6aac001e0008d40c0ba4389f1247ad36" - the id they can see. They do not have
     * the Agent Manager run id, and asking them for it to approve something they
     * have already approved is the kind of friction that stops the gate being
     * used at all. So the ids travel into the catalog and approve_intake takes
     * either one.
     */
    const refs = []
    for (const st of steps) {
        if (st.status === 'discarded') continue
        const payload = st.provenance && st.provenance.upstream_payload
        if (!payload) continue
        for (const r of narrate.findWorkfrontRefs(payload.output)) {
            if (!refs.some(x => x.objId === r.objId)) refs.push(r)
        }
    }
    resource.workfront_refs = refs.length ? refs : undefined
    if (now) { resource.updated = now; resource.updated_at = now }
}

/**
 * Validate a save_resource request against its policy entry.
 * @param {object} policyEntry
 * @param {{title: string, content: string, format?: string, project?: string, tags?: string[], fields?: object}} input
 * @returns {{ error?: string, format?: string }}
 */
function validateAgainstPolicy (policyEntry, { title, content, format, project, tags, fields }) {
    let chosenFormat = format
    if (!chosenFormat) {
        if (policyEntry.format.length === 1) {
            chosenFormat = policyEntry.format[0]
        } else {
            return { error: `Resource type '${policyEntry.type}' supports multiple formats (${policyEntry.format.join(', ')}) - specify one via the 'format' argument` }
        }
    }
    if (!policyEntry.format.includes(chosenFormat)) {
        return { error: `Invalid format '${chosenFormat}' for type '${policyEntry.type}' - must be one of ${policyEntry.format.join(', ')}` }
    }

    const candidate = { title, content, project, tags, ...fields }
    const missing = (policyEntry.schema.required || []).filter(field => {
        const value = candidate[field]
        return value === undefined || value === null || value === ''
    })
    if (missing.length) {
        return { error: `Missing required field(s) for type '${policyEntry.type}': ${missing.join(', ')}` }
    }

    return { format: chosenFormat }
}

/**
 * Register all tools with the MCP server
 * @param {McpServer} server - The MCP server instance
 * @param {{ userInfo?: object }} [context] - caller identity resolved from IMS auth, if any
 */
/**
 * Why a general capture was refused, said in a way that helps.
 *
 * Naming the right server matters: a client that has been told to capture its
 * work will otherwise retry, or decide the call failed for a transport reason.
 */
function refuseCapture (what) {
    return errorResult(
        `Refused: ${what} is not what CX Agent Manager records. ` +
        'This service holds what the Workfront intake AGENTS did - runs come from start_intake - ' +
        'plus the way a human steered those runs (append_step with kind "steering" on an existing agent run). ' +
        'A normal conversation, and anything you produced in one, belongs in the company cookbook, ' +
        'which is a different server. ' +
        'An admin can allow general capture with update_settings({capture_mode: "open"}) if that is genuinely wanted.'
    )
}

/** Is this an agent run - i.e. did start_intake create it? */
function isAgentRunResource (resource) {
    return !!(resource && resource.upstream)
}

function registerTools (server, context = {}) {
    // READ-ONLY CHOKE POINT (D79). Wrap registration once so every write tool is gated for a
    // `viewer` identity without repeating a guard in ~20 handlers - and so a write tool added
    // later cannot silently escape the gate (WRITE_TOOLS is asserted against the live
    // registration set in tests). Reads pass through untouched, as does every non-viewer caller.
    const registerRaw = server.tool.bind(server)
    server.tool = (name, description, schema, handler) => registerRaw(name, description, schema,
        async (...handlerArgs) => {
            if (WRITE_TOOLS.has(name) && callerHasRole(context, 'viewer')) {
                /*
                 * "Ask an admin for a chef role" - the cookbook engine's
                 * vocabulary, put to a Comcast marketer. There is no chef here
                 * and there never was: the role is called Marketer in this
                 * product, and the dashboard has said so since the rename.
                 *
                 * Also says what they CAN still do, because the commonest
                 * reason to hit this is wanting to look at something, and
                 * reading and previewing are both open to a viewer.
                 */
                return errorResult(
                    `Refused: this is a read-only identity, and '${name}' changes data. ` +
                    'You can still read anything shared with you, and preview an intake without filing it. ' +
                    'To file or approve work, ask an admin for the Marketer role.'
                )
            }
            return handler(...handlerArgs)
        })

    /**
     * Ensure a Project RECORD exists for this name (D49/D52) - project records are the
     * source of truth, so start_project / set_work_context / the first save all
     * auto-create one. Idempotent (upsert selects an existing record). Best-effort: a
     * record-write hiccup never blocks the actual save.
     * @param {string} [name]
     */
    async function ensureProject (name) {
        if (!name) return
        try { await store.upsertProjectByName({ name, owner: resolvePrincipal(context) }) } catch (e) { /* non-fatal */ }
    }

    server.tool(
        'get_resource_policy',
        'Get the full company resource policy: every resource type this connector accepts, its required fields, allowed formats, storage routing, capture trigger, and approval rule. Call this to learn what to capture and how before using save_resource. Titles reflect any Settings overrides (D48).',
        {},
        async () => {
            const overrides = settings.kindLabelOverrides()
            return jsonResult(policy.listResourceTypes().map(t => (overrides[t.type] ? { ...t, title: overrides[t.type] } : t)))
        }
    )

    server.tool(
        'list_resource_types',
        'List just the resource type ids, titles, and descriptions from the company resource policy - a lighter-weight alternative to get_resource_policy.',
        {},
        async () => {
            const overrides = settings.kindLabelOverrides()
            return jsonResult(policy.listResourceTypes().map(({ type, title, description }) => ({ type, title: overrides[type] || title, description })))
        }
    )

    server.tool(
        'save_resource',
        `Record a run. Validated against the resource policy (call get_resource_policy for all kinds); routed to that kind's storage automatically. Everything is saved EXPERIMENTAL and stays experimental until a human certifies it - only then does it enter the shared cookbook (handoff-prompt is exempt - it uses task_status, not certification). project is required (start a project with start_project or set_work_context); other segment levels (${SEGMENT_LEVEL_KEYS.join(', ')}) are auto-filled. To refine earlier work, pass the existing job's id to UPDATE it in place (new version) - do not create a duplicate. Current kinds: ${POLICY_TYPE_IDS.join(', ')}.`,
        {
            type: z.enum(POLICY_TYPE_IDS).describe('Resource kind id - see get_resource_policy for the full list'),
            title: z.string().min(1).describe('Short, descriptive title for the job'),
            content: z.string().min(1).describe('The full content of the job'),
            format: z.string().optional().describe('Content format - must be one the kind allows; optional if the kind allows only one format'),
            id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,160}$/i).optional().describe('Stable job id. If a job with this id exists it is UPDATED in place (version++, prior version kept in history); otherwise created with this id. Omit for a generated id. Pass the existing id when refining earlier work - do NOT create a new job.'),
            project: z.string().optional().describe('Project this job belongs to (required unless set via start_project/set_work_context, or the kind is handoff-prompt)'),
            epic: z.string().optional().describe('Segment level: epic (defaults to the set_work_context value)'),
            story: z.string().optional().describe('Segment level: story (defaults to the set_work_context value)'),
            task: z.string().optional().describe('Optional task label within the story'),
            segments: z.record(z.string(), z.string()).optional().describe('Segment level values keyed by configured level key (see get_segmentation_config) - an alternative to the project/epic/story arguments'),
            tags: z.array(z.string()).optional().describe('Optional list of tags for discovery'),
            fields: z.record(z.string(), z.any()).optional().describe("Additional kind-specific fields required by the policy (e.g. 'system' for architecture-diagram), plus free-form provenance (source, session...)"),
            tokens_used: z.number().int().nonnegative().optional().describe('Tokens this save consumed (best-effort, AI-reported). Accumulated across a job\'s revisions.'),
            model: z.string().optional().describe('Free-text model identifier that produced this content (vendor-neutral), e.g. "opus-4.8". Shown per step in the dashboard.'),
            job_id: z.string().optional().describe('For kind "handoff-prompt": the id of the task-thread Job this prompt belongs to, so the agent that picks it up appends its work to the same job (get_active_job / start_job).'),
            target_agent: z.string().optional().describe('For kind "handoff-prompt": which agent or coding tool this prompt is for - see get_resource_policy\'s target_agents hint'),
            task_status: z.enum(TASK_STATUSES).optional().describe('For kind "handoff-prompt": the task lifecycle status - defaults to "open"')
        },
        async ({ type, title, content, format, id, project, epic, story, task, segments, tags, fields, tokens_used: tokensDelta, model, job_id: jobId, target_agent: targetAgent, task_status: taskStatus }) => {
            /*
             * A handoff-prompt is a POINTER to work somebody else will do, not a
             * record of a conversation, and the server instructions actively ask
             * clients to write them - so it stays allowed. Everything else is
             * general capture, which is not this service's job.
             */
            if (settings.captureMode() !== 'open' && type !== HANDOFF_TYPE) {
                return refuseCapture(`saving a "${type}"`)
            }
            const policyEntry = policy.getResourceType(type)
            if (!policyEntry) {
                return errorResult(`Unknown resource type '${type}'`)
            }

            const validation = validateAgainstPolicy(policyEntry, { title, content, format, project, tags, fields })
            if (validation.error) {
                return errorResult(validation.error)
            }

            // Resolve segments: explicit args/segments-map win; else the stored work-context default.
            const workCtx = await store.getWorkContext()
            const explicit = { ...(segments || {}) }
            if (project !== undefined) explicit.project = project
            if (epic !== undefined) explicit.epic = epic
            if (story !== undefined) explicit.story = story
            const resolvedSegments = {}
            const levelDefaults = workCtx.segments || {}
            for (const key of SEGMENT_LEVEL_KEYS) {
                const v = explicit[key] !== undefined ? explicit[key] : levelDefaults[key]
                if (v !== undefined && v !== '') resolvedSegments[key] = v
            }
            // carry through any explicit non-standard segment keys too (config may add levels)
            for (const [k, v] of Object.entries(explicit)) {
                if (resolvedSegments[k] === undefined && v !== undefined && v !== '') resolvedSegments[k] = v
            }
            const resolvedProject = resolvedSegments.project
            const resolvedTask = task !== undefined ? task : workCtx.task

            if (type !== HANDOFF_TYPE && !resolvedProject) {
                return errorResult('project is required: start one with start_project (or pass "project", or set it via set_work_context). Work is scoped by programme so unrelated work stays separate.')
            }
            // Project records are the source of truth (D49): the first save into a project
            // auto-creates its record so the dashboard lists it, no phantom-from-segments.
            await ensureProject(resolvedProject)

            if (type === HANDOFF_TYPE && taskStatus === undefined) {
                taskStatus = 'open'
            }

            const now = new Date().toISOString()
            const owner = resolvePrincipal(context)
            const author = resolveAuthor(context)
            const gated = policyEntry.approval === 'human-gate'
            const newHash = contentHash(content)

            let ownerFinal = owner
            let authorFinal = author
            let existing = null
            if (id) {
                existing = await store.getResource(id)
            } else {
                id = makeResourceId(type, title)
            }

            let created = now
            let version = 1
            let history
            let status
            let approved, approvedAt, approvedBy, approvalNote
            let tokensTotal = tokensDelta != null ? tokensDelta : undefined
            let tokensLast = tokensDelta != null ? tokensDelta : undefined
            let updatedAt
            let existed = false
            let reapproved = false
            let linkedJobs

            if (existing) {
                // An id is a guessable string, so "pass the same id to update in place" was also
                // "pass someone else's id to overwrite their work".
                if (!callerCanWrite(existing, context)) return notWritableError(id)
                existed = true
                created = existing.created || now
                updatedAt = now
                linkedJobs = existing.linked_jobs
                // Authorship belongs to whoever did the work, not to whoever touched it last.
                ownerFinal = existing.owner || owner
                authorFinal = existing.author || author
                const prevHash = existing.content_hash || contentHash(existing.content)
                const materialChange = prevHash !== newHash

                const prevTotal = Number(existing.tokens_used) || 0
                tokensTotal = tokensDelta != null ? prevTotal + tokensDelta : existing.tokens_used
                tokensLast = tokensDelta != null ? tokensDelta : existing.tokens_last

                history = Array.isArray(existing.history) ? existing.history.slice() : []

                if (materialChange) {
                    version = (Number(existing.version) || 1) + 1
                    // Lineage: keep the prior version's metadata (not its full content, so
                    // memory stays bounded - the whole point of update-not-duplicate).
                    history.push({
                        version: Number(existing.version) || 1,
                        title: existing.title,
                        updated_at: existing.updated_at || existing.updated || existing.created,
                        content_hash: prevHash,
                        status: existing.status,
                        approved_by: existing.approved_by,
                        approved_at: existing.approved_at,
                        tokens_used: existing.tokens_used
                    })
                    if (statusLib.isApproved(existing.status) && REAPPROVE_ON_CHANGE) {
                        // Re-consent on material change (D38): an approved job returns to
                        // experimental; its prior approval is preserved in history above.
                        status = statusLib.EXPERIMENTAL
                        reapproved = true
                    } else {
                        status = existing.status
                        approved = existing.approved; approvedAt = existing.approved_at
                        approvedBy = existing.approved_by; approvalNote = existing.approval_note
                    }
                } else {
                    // Metadata-only update (e.g. re-segmentation/migration): keep version,
                    // status, and approval untouched.
                    version = Number(existing.version) || 1
                    status = existing.status || (gated ? statusLib.EXPERIMENTAL : statusLib.APPROVED)
                    approved = existing.approved; approvedAt = existing.approved_at
                    approvedBy = existing.approved_by; approvalNote = existing.approval_note
                }
            } else {
                status = gated ? statusLib.EXPERIMENTAL : statusLib.APPROVED
            }

            const resource = {
                id, title, type, content, content_hash: newHash, format: validation.format,
                project: resolvedProject, segments: resolvedSegments,
                epic: resolvedSegments.epic, story: resolvedSegments.story, task: resolvedTask,
                tags, fields, owner: ownerFinal, author: authorFinal,
                created, updated: updatedAt, updated_at: updatedAt, version, status,
                approved, approved_at: approvedAt, approved_by: approvedBy, approval_note: approvalNote,
                tokens_used: tokensTotal, tokens_last: tokensLast,
                storage: policyEntry.storage,
                target_agent: targetAgent, task_status: taskStatus,
                job_id: jobId !== undefined ? jobId : (existing ? existing.job_id : undefined),
                baked: existing ? existing.baked : undefined,
                baked_at: existing ? existing.baked_at : undefined,
                baked_by: existing ? existing.baked_by : undefined,
                // CX-graph admission MUST survive an update-in-place (D79 bugfix). This object is a
                // full rebuild, so any field not carried over here is silently DROPPED - and losing
                // cx_approved silently evicted an already-admitted job from the Company CX Graph
                // the next time anyone refined it. Found by the E2E validation, not by a unit test,
                // because it only shows up in the save -> headchef_approve -> save-again sequence.
                cx_approved: existing ? existing.cx_approved : undefined,
                cx_approved_by: existing ? existing.cx_approved_by : undefined,
                cx_approved_at: existing ? existing.cx_approved_at : undefined,
                // Practice/capability group (D79): preserved on update, inherited from the
                // consultant's own practice on create - same rule as start_job, so a job
                // never silently loses the discipline that makes it findable.
                practice: existing ? existing.practice : (settings.defaultPracticeFor(owner) || undefined),
                linked_jobs: linkedJobs,
                history: history && history.length ? history : undefined
            }

            // Increment 11 (D45): save_resource is a back-compat wrapper that always
            // targets a job's step at order 0. Everything above is unchanged from
            // Increment 9/10 (version/history/reapprove-on-change/tokens computed exactly
            // as before) so the single-step case - every job created this way, and all
            // 65 migrated jobs - behaves identically. Composing status/content/tokens
            // across ALL of the job's steps (not just step 0) keeps a job correct if
            // it later grows via append_step.
            const priorSteps = existing ? stepsLib.ensureSteps(existing) : []
            const priorStep0 = priorSteps.find(s => s.order === 0)
            const step0 = {
                id: stepsLib.makeStepId(id, 0),
                job_id: id,
                order: 0,
                source: (priorStep0 && priorStep0.source) || (fields && fields.source) || 'unknown',
                model: model !== undefined ? model : (priorStep0 ? priorStep0.model : undefined),
                kind: (priorStep0 && priorStep0.kind) || stepsLib.kindForType(type),
                content,
                format: validation.format,
                owner,
                tokens_used: tokensTotal,
                tokens_last: tokensLast,
                provenance: fields,
                created,
                updated: now,
                status,
                approved_by: approvedBy,
                approved_at: approvedAt,
                approval_note: approvalNote,
                expires_at: statusLib.isExperimental(status) ? stepsLib.computeExpiry(now) : undefined,
                tags
            }
            const allSteps = [step0, ...priorSteps.filter(s => s.order !== 0)]
            // step0.status already carries save_resource's version/history-aware value
            // (incl. reapprove-on-change); projectJob derives the job-level status
            // from all steps (honoring bake) and composes content/tokens/models/step_count.
            projectJob(resource, allSteps)

            await store.saveResource(resource)

            // D84: warn when this looks like a SIBLING of work just captured - one working thread
            // that produced several artifacts. save_resource creates one job per call, so an AI
            // saving an architecture-diagram and then an architecture-doc for the same task ends up
            // with two 1-ingredient jobs instead of one job with two ingredients. Observed
            // live: two jobs 20 seconds apart, same project, same subject, one baked and one not,
            // which made the work look half-finished to its author and to the Head Chef. This does
            // not block the save - guessing wrong must not lose someone's work - it tells the caller
            // what to do instead.
            let siblingHint
            if (!existed) {
                try {
                    siblingHint = await findRecentSibling({ id, title, project: resource.project, owner, now })
                } catch (e) { siblingHint = undefined }
            }

            return jsonResult({
                id, status, version,
                ...(existed ? { updated: true } : {}),
                ...(reapproved ? { reapproved_to_experimental: true } : {}),
                ...(siblingHint ? { warning: siblingHint } : {})
            })
        }
    )

    server.tool(
        'start_project',
        'Start (or select) a Project - the top segmentation level. Call this at the start of a new, unrelated conversation and name it, so its jobs stay separate from other work. Sets the active project for subsequent save_resource calls and returns the project id.',
        {
            name: z.string().min(1).describe('A short, descriptive project name'),
            note: z.string().optional().describe('Optional note describing the project')
        },
        async ({ name, note }) => {
            const project = await store.upsertProjectByName({ name, note, owner: resolvePrincipal(context) })
            await store.setWorkContext({ project: name })
            return jsonResult({ id: project.id, name: project.name, note: project.note, selected: project.existed })
        }
    )

    server.tool(
        'set_work_context',
        'Set the active project and default segment levels for this workspace. Applied to every subsequent save_resource that does not declare its own. Accepts project/epic/story (and a generic segments map). Call with no arguments to clear it. Values replace the previous context entirely.',
        {
            project: z.string().optional().describe('The active project'),
            epic: z.string().optional().describe('Default epic'),
            story: z.string().optional().describe('Default story'),
            task: z.string().optional().describe('Default task'),
            segments: z.record(z.string(), z.string()).optional().describe('Default segment values keyed by configured level key (alternative to project/epic/story)')
        },
        async ({ project, epic, story, task, segments }) => {
            const stored = await store.setWorkContext({ project, epic, story, task, segments })
            await ensureProject(stored.project) // project records are source of truth (D49)
            return jsonResult(stored)
        }
    )

    server.tool(
        'get_segmentation_config',
        'Get the configured segmentation levels (ordered { key, label }) - how jobs are organized by unit of work. project is the required top level; the rest are auto-filled. Labels reflect any Settings overrides (D48).',
        {},
        async () => {
            const base = segmentation.getConfig()
            const overrides = settings.segmentationLabelOverrides()
            return jsonResult({ levels: base.levels.map(l => ({ key: l.key, label: overrides[l.key] || l.label })) })
        }
    )

    server.tool(
        'find_similar',
        'Find existing jobs similar to a title or snippet BEFORE saving, so you update the right job instead of creating a near-duplicate. Returns lightweight matches (id, title, kind, status, segments).',
        {
            query: z.string().min(1).describe('A title or snippet to match against existing jobs'),
            project: z.string().optional().describe('Restrict to a project (recommended - scope to the current work)')
        },
        async ({ query, project }) => {
            // D99: scoped like every other search. Before this it returned any job in the
            // company, so a caller could discover a colleague's private work by guessing words.
            const matches = await store.searchResources(query, {
                ...(project ? { project } : {}),
                visibleTo: resolvePrincipal(context),
                visibleSubmitted: callerCanReview(context)
            })
            return jsonResult(matches.slice(0, 10).map(m => ({
                id: m.id, title: m.title, type: m.type, status: m.status, segments: m.segments || {}
            })))
        }
    )

    /**
     * Shared consent/approval handler for approve_resource + certify (D38).
     * @param {string} id
     * @param {string} [note]
     * @returns {Promise<object>}
     */
    /**
     * Look for a job by the same owner, in the same project, created in the last few minutes,
     * whose title covers the same subject - i.e. almost certainly another artifact from the SAME
     * working thread (D84).
     *
     * Deliberately conservative: same owner, same project, a short time window, and a real overlap
     * of meaningful title words. A false positive only ever produces an advisory string, but a
     * noisy advisory teaches callers to ignore advisories, so the bar is set high.
     *
     * @param {{id: string, title: string, project?: string, owner: string, now: string}} input
     * @returns {Promise<string|undefined>} a hint for the caller, or undefined
     */
    async function findRecentSibling ({ id, title, project, owner, now }) {
        const WINDOW_MS = 10 * 60 * 1000
        const nowMs = Date.parse(now) || Date.now()
        const words = (s) => new Set(String(s || '').toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(w => w.length > 3 && !['with', 'from', 'that', 'this', 'into', 'record', 'system'].includes(w)))

        const mine = words(title)
        if (mine.size < 2) return undefined

        const candidates = (await store.listResources({ owner, ...(project ? { project } : {}) }))
            .filter(r => r.id !== id && r.type !== HANDOFF_TYPE)
            .filter(r => Math.abs(nowMs - (Date.parse(r.created || r.updated || '') || 0)) < WINDOW_MS)

        for (const r of candidates) {
            const theirs = words(r.title)
            const shared = [...mine].filter(w => theirs.has(w))
            // Two or more shared meaningful words, and most of the shorter title in common.
            if (shared.length >= 2 && shared.length >= Math.min(mine.size, theirs.size) * 0.5) {
                return `This looks like a second artifact from the same work as '${r.id}' ("${r.title}"), created minutes ago in the same project. ` +
                    'Both are now SEPARATE jobs with one ingredient each, which splits one piece of work in two: each looks half-finished, and each has to be curated and baked on its own. ' +
                    `If they belong together, capture the rest as INGREDIENTS of one job instead: append_step({job_id: '${r.id}', kind: 'diagram'|'doc'|'code'|..., content, model, tokens_used}). ` +
                    'Use save_resource for a NEW, distinct piece of work, or with an EXISTING id to refine that job in place.'
            }
        }
        return undefined
    }

    async function certifyHandler (id, note) {
        const resource = await store.getResource(id)
        if (!resource) {
            return errorResult(`No resource found with id '${id}'`)
        }
        if (resource.type === HANDOFF_TYPE) {
            return errorResult(`Resource '${id}' is a handoff-prompt, not a cookbook job - handoffs use set_task_status, not certification`)
        }
        if (!callerCanWrite(resource, context)) return notWritableError(id)
        // Idempotent, not an error (D79): approving any step already promotes the job, so a
        // caller following the documented capture -> approve -> certify order would otherwise hit
        // a hard failure for asking for a state the job is already in. The intent is satisfied;
        // say so, and flag that nothing changed so an agent does not report a fresh consent.
        if (statusLib.isApproved(resource.status)) {
            return jsonResult({
                id,
                status: resource.status,
                already_approved: true,
                approved_by: resource.approved_by,
                approved_at: resource.approved_at,
                note: `Already certified - no change made. Consent was recorded by ${resource.approved_by || 'a human'}${resource.approved_at ? ` at ${resource.approved_at}` : ''}.`
            })
        }
        const now = new Date().toISOString()
        const principal = resolvePrincipal(context)
        resource.approved = now // legacy field (existing dashboard reads this)
        resource.approved_at = now
        resource.approved_by = principal
        if (note) resource.approval_note = note

        // Keep step 0 in sync (D45) so the ordered-step views (get_job/list_steps)
        // agree with this legacy, whole-job consent record.
        const steps = stepsLib.ensureSteps(resource)
        const step0 = steps.find(s => s.order === 0)
        if (step0) {
            step0.status = statusLib.APPROVED
            step0.approved_by = principal
            step0.approved_at = now
            if (note) step0.approval_note = note
            step0.expires_at = undefined
        }
        projectJob(resource, steps, now)

        await store.saveResource(resource)
        return jsonResult({ id, status: resource.status, approved_by: principal, approved_at: now, ...(note ? { approval_note: note } : {}) })
    }

    server.tool(
        'approve_resource',
        'Certify an experimental job as a human consent, promoting it to "approved" so it enters Playbooks. Records who approved it and when. (Alias: certify.)',
        {
            id: z.string().min(1).describe('The job id to approve')
        },
        async ({ id }) => certifyHandler(id)
    )

    server.tool(
        'certify',
        'Certify (approve) an experimental job - a human consent that promotes it into Playbooks, recording approved_by, approved_at, and an optional note. Same effect as approve_resource, with a note. NOT the process approval at 1.5: this changes whether the RECORD is kept as knowledge, and nothing about whether the campaign proceeds. If a run is sitting at awaiting_approval, the tool that moves it is approve_intake.',
        {
            id: z.string().min(1).describe('The job id to certify'),
            note: z.string().optional().describe('Optional consent note (why it is being certified)')
        },
        async ({ id, note }) => certifyHandler(id, note)
    )

    server.tool(
        'export_as_skill',
        `Export a certified (house) job as a portable skill/prompt any AI can consume (D31). For a multi-step job this is the end-to-end REPLAY: its approved steps in order (prompts, decisions, code, diagram/image references) so another AI can redo the task (D47). Only approved/baked jobs can be exported - an experimental one must be certified or baked first. Formats: ${skills.describeFormats()}.`,
        {
            job_id: z.string().min(1).describe('The job id to export, as returned by save_resource or list_resources'),
            format: z.enum(skills.listFormats()).optional().describe('Export format - defaults to "prompt" (portable, any AI)')
        },
        async ({ job_id: jobId, format }) => {
            const resource = await store.getResource(jobId)
            if (!resource) {
                return errorResult(`No job found with id '${jobId}'`)
            }
            if (!callerCanRead(resource, context)) return notVisibleError(jobId)
            try {
                // Export the APPROVED-steps view (D45), not the full working log - a
                // multi-step job may still carry unreviewed drafts. A job with more
                // than one approved step exports as an ordered end-to-end replay walkthrough
                // (D47); a single-step job exports its plain content as before.
                const allSteps = stepsLib.ensureSteps(resource)
                const approvedSteps = allSteps.filter(s => s.status !== 'discarded' && statusLib.isApproved(s.status))
                const content = approvedSteps.length > 1
                    ? stepsLib.composeReplay(allSteps, { approvedOnly: true })
                    : stepsLib.composeContent(allSteps, { approvedOnly: true })
                const approvedView = { ...resource, content }
                return jsonResult(skills.exportJob(approvedView, format))
            } catch (e) {
                return errorResult(e.message)
            }
        }
    )

    server.tool(
        'list_active_tasks',
        'List handoff-prompts that are still open or in progress (the active-tasks queue, D36) - newest first. Use this to pick up a prompt that was handed off for another agent/coding tool to execute.',
        {},
        async () => {
            const visibleTo = resolvePrincipal(context) // personal task queue (D53)
            const visibleSubmitted = callerCanReview(context)
            const [open, inProgress] = await Promise.all([
                store.listResources({ type: 'handoff-prompt', task_status: 'open', visibleTo, visibleSubmitted }),
                store.listResources({ type: 'handoff-prompt', task_status: 'in_progress', visibleTo, visibleSubmitted })
            ])
            const active = [...open, ...inProgress].sort((a, b) => (b.created || '').localeCompare(a.created || ''))
            return jsonResult(active)
        }
    )

    server.tool(
        'set_task_status',
        'Move a handoff-prompt through its task lifecycle: open -> in_progress -> done. This is independent of the job\'s approval status.',
        {
            id: z.string().min(1).describe('The handoff-prompt id'),
            status: z.enum(TASK_STATUSES).describe('The new task status')
        },
        async ({ id, status }) => {
            const resource = await store.getResource(id)
            if (!resource) {
                return errorResult(`No resource found with id '${id}'`)
            }
            if (resource.type !== 'handoff-prompt') {
                return errorResult(`Resource '${id}' is a '${resource.type}', not a handoff-prompt - set_task_status only applies to handoff-prompts`)
            }
            resource.task_status = status
            await store.saveResource(resource)
            return jsonResult({ id, task_status: status })
        }
    )

    server.tool(
        'link_jobs',
        'Record lineage from a handoff-prompt to the job(s) it produced, once the handed-off work is done - builds the brainstorm -> build -> outcome graph (D36).',
        {
            handoff_id: z.string().min(1).describe('The handoff-prompt id'),
            job_ids: z.array(z.string().min(1)).min(1).describe('The id(s) of jobs this handoff produced')
        },
        async ({ handoff_id: handoffId, job_ids: jobIds }) => {
            const handoff = await store.getResource(handoffId)
            if (!handoff) {
                return errorResult(`No resource found with id '${handoffId}'`)
            }
            if (handoff.type !== 'handoff-prompt') {
                return errorResult(`Resource '${handoffId}' is a '${handoff.type}', not a handoff-prompt - link_jobs only applies to handoff-prompts`)
            }
            if (!callerCanWrite(handoff, context)) return notWritableError(handoffId)
            const existing = new Set(handoff.linked_jobs || [])
            for (const jobId of jobIds) existing.add(jobId)
            handoff.linked_jobs = [...existing]
            await store.saveResource(handoff)
            return jsonResult({ id: handoffId, linked_jobs: handoff.linked_jobs })
        }
    )

    server.tool(
        'list_resources',
        'Discover runs in Playbooks. Returns metadata only (no full content) - use get_resource to read one. Filters are project-scoped by intent: pass a project to see just that project\'s work. Status filter accepts experimental/approved (pending/active still work as aliases).',
        {
            project: z.string().optional().describe('Filter by project'),
            type: z.enum(POLICY_TYPE_IDS).optional().describe('Filter by job kind'),
            tag: z.string().optional().describe('Filter by tag'),
            status: z.enum(['experimental', 'approved', 'pending', 'active']).optional().describe('Filter by approval status (experimental/approved; pending/active are aliases)'),
            epic: z.string().optional().describe('Filter by epic segment'),
            story: z.string().optional().describe('Filter by story segment'),
            practice: z.string().optional().describe('Filter by practice / capability group (aem, aep, braze, campaign - see list_practices)'),
            owner: z.string().optional().describe('Filter by owner (the identity that captured the job)')
        },
        async ({ project, type, tag, status, epic, story, owner, practice }) => {
            // Multi-tenant isolation (D53): a personal listing returns the caller's own
            // jobs plus approved (cross-owner-visible) ones. On the x-api-key path the
            // caller is the single service principal, so this is a no-op until per-user OAuth.
            const entries = await store.listResources({ project, type, tag, status, epic, story, owner, practice, visibleTo: resolvePrincipal(context), visibleSubmitted: callerCanReview(context) })
            return jsonResult(entries)
        }
    )

    server.tool(
        'search_resources',
        'Find jobs by keyword (case-insensitive over title, tags, and content), optionally scoped by project/kind/status/segment/owner. Search here BEFORE saving to update an existing job instead of duplicating it.',
        {
            query: z.string().min(1).describe('Keyword or phrase to search for'),
            project: z.string().optional().describe('Filter by project'),
            type: z.enum(POLICY_TYPE_IDS).optional().describe('Filter by job kind'),
            status: z.enum(['experimental', 'approved', 'pending', 'active']).optional().describe('Filter by approval status (experimental/approved; pending/active are aliases)'),
            epic: z.string().optional().describe('Filter by epic segment'),
            story: z.string().optional().describe('Filter by story segment'),
            practice: z.string().optional().describe('Filter by practice / capability group (aem, aep, braze, campaign - see list_practices)'),
            owner: z.string().optional().describe('Filter by owner')
        },
        async ({ query, project, type, status, epic, story, owner, practice }) => {
            const entries = await store.searchResources(query, { project, type, status, epic, story, owner, practice, visibleTo: resolvePrincipal(context), visibleSubmitted: callerCanReview(context) })
            return jsonResult(entries)
        }
    )

    server.tool(
        'get_resource',
        'Read a resource\'s full content by id from the shared company resource store.',
        {
            id: z.string().min(1).describe('The resource id, as returned by save_resource or list_resources')
        },
        async ({ id }) => {
            const resource = await store.getResource(id)
            if (!resource) {
                return errorResult(`No resource found with id '${id}'`)
            }
            if (!callerCanRead(resource, context)) return notVisibleError(id)
            return jsonResult(resource)
        }
    )

    // --- Ordered Step/Job model (Increment 11, D45) ---------------------------------
    // A Job is an ordered container of Steps within a Project. The experimental job
    // is the full ordered step log; its cookbook view is just the approved steps, in their
    // original order. save_resource above remains a single-step shortcut (always step 0);
    // these tools are the multi-step path for a working session with more than one output.

    server.tool(
        'start_job',
        'Start a new, empty ordered Job - a working thread/session inside a Project. You then append its outputs in order with append_step. Distinct from start_project (which selects the Project itself). The job is experimental until at least one of its steps is approved.',
        {
            project: z.string().min(1).describe('The project this job belongs to (start/select one first with start_project)'),
            title: z.string().min(1).describe('A short, descriptive title for this job / working thread'),
            practice: z.string().optional().describe('Practice / capability group this work belongs to (e.g. aem, aep, braze, campaign - call list_practices). Omit to inherit your own configured practice, which is the normal case.'),
            segments: z.record(z.string(), z.string()).optional().describe('Optional additional segment level values (see get_segmentation_config)')
        },
        async ({ project, title, practice, segments }) => {
            await ensureProject(project) // a task thread implies its project record exists (D49)
            const now = new Date().toISOString()
            const owner = resolvePrincipal(context)
            const id = makeResourceId('job', title)
            const resolvedSegments = { ...(segments || {}), project }
            // Practice (D79): an explicit value wins, else inherit the consultant's own practice so
            // an AEM consultant's work lands in AEM with zero extra effort. An unknown id is a hard
            // error rather than silently stored, or the filter would quietly miss this job.
            const resolvedPractice = practice || settings.defaultPracticeFor(owner)
            if (practice && !settings.practiceIds().includes(practice)) {
                return errorResult(`Unknown practice '${practice}'. Valid: ${settings.practiceIds().join(', ') || '(none configured)'} - see list_practices.`)
            }
            // Runs are created by start_intake, from a brief, by the pipeline.
            // An empty thread opened by a chat client is the beginning of exactly
            // the capture this service does not do.
            if (settings.captureMode() !== 'open') {
                return refuseCapture('starting a new working thread')
            }
            const resource = {
                id,
                title,
                type: 'job',
                content: '',
                content_hash: contentHash(''),
                project,
                practice: resolvedPractice || undefined,
                segments: resolvedSegments,
                owner,
                author: resolveAuthor(context),
                created: now,
                updated: now,
                updated_at: now,
                version: 1,
                status: statusLib.EXPERIMENTAL,
                steps: []
            }
            await store.saveResource(resource)
            return jsonResult({ id, title, project, practice: resolvedPractice || null, status: resource.status, created: now })
        }
    )

    /* -----------------------------------------------------------------
       Agent systems: the bridge between a marketer's brief and the
       upstream pipeline that executes it.

       start_intake is the one tool a marketer's assistant actually needs.
       The others are for seeing what is registered.
       ----------------------------------------------------------------- */

    server.tool(
        'list_agent_systems',
        'List the upstream agent systems registered with Agent Manager - one per executing system, each bound to a domain and an adapter. Use this to see what can run a brief. Agent names are NOT listed here; call list_system_agents, which reads them from the upstream itself.',
        {},
        async () => jsonResult(agentSystems.list(settings.agentSystems()))
    )

    server.tool(
        'list_system_agents',
        "List the agents an upstream system actually has, read live from that system's own catalog rather than from any list held here. An agent added upstream appears immediately, with nothing changed on this side.",
        {
            system_id: z.string().optional().describe('Which system. Omit when only one is active.')
        },
        async ({ system_id: systemId }) => {
            const { system, error } = agentSystems.resolve(systemId, undefined, settings.agentSystems())
            if (error) return errorResult(error)
            try {
                return jsonResult({ system: system.id, agents: await agentSystems.discoverAgents(system) })
            } catch (e) {
                return errorResult(`Could not reach ${system.id}: ${e.message}`)
            }
        }
    )

    server.tool(
        'start_intake',
        "Start a campaign intake from a marketer's brief in plain English. Hands the brief to the upstream agent pipeline, waits for it, and logs every stage as artifacts of ONE run so the whole thing is reviewable afterwards. Returns the run id, what each agent did, and anything that failed - including a tool failure an agent reported as a success. Use this rather than calling the upstream directly, or nothing is captured.\n\nPASS `fields` WITH WHAT THE BRIEF ALREADY SAYS. You have read it; the pipeline should not have to guess at its layout. A brief whose rows are tab-separated - which is what copying the BU's table out of Workfront produces - read as EMPTY, and the marketer was then asked, over seven round trips, for fourteen things the table answered on screen. Filling `fields` is what makes the layout irrelevant. Leave out anything the brief does not say: a value you supply is checked against the brief's own words, and one it cannot support is reported as ungrounded rather than filed.",
        {
            brief: z.string().min(1).describe("The marketer's brief, in their own words - verbatim, including its table, not your summary of it"),
            fields: z.record(z.string()).optional().describe(
                'What the brief already answers, as you read it. Keys and permitted values:\n' +
                '  campaign_name      free text\n' +
                '  business_objective Growth/Upsell | Retention | Acquisition\n' +
                '  customer_type      Subscriber - Existing Customers | Prospect - Non-Customers\n' +
                '  line_of_business   Residential (RES) | Business (SMB)\n' +
                '  request_type       Audience Build-Only | Audience + Campaign Execution\n' +
                '  launch_date        the in-market date, ISO yyyy-mm-dd if the brief gives one\n' +
                '  lifecycle_journey  Upgrade | Winback | Onboarding | Cross-sell\n' +
                '  campaign_duration  Evergreen (ongoing) | Fixed window\n' +
                '  cadence            One-time Campaign | Recurring Campaign\n' +
                '  activation_pattern Batch | Near-real time trigger\n' +
                '  channels           Email | SMS | Direct Mail | Paid Media | In-app | Outbound Call | Push\n' +
                '  region             Northeast | Southeast | Midwest | West | Southwest | National\n' +
                '  offer              free text\n' +
                '  exclusion          who to suppress, free text\n' +
                '  audience_description the audience rule as the brief states it, verbatim where it gives one\n' +
                'Omit a key the brief is silent on. Do not infer one to look complete - an ' +
                'unanswered field becomes a short question to the marketer, which is correct, ' +
                'and a wrong one becomes a campaign built against the wrong audience.'
            ),
            title: z.string().optional().describe('A short title for the run. Defaults to the first line of the brief.'),
            project: z.string().optional().describe('Programme this run belongs to. Defaults to the active work context.'),
            system_id: z.string().optional().describe('Which agent system to run it on. Omit when only one is active.'),
            wait_ms: z.number().int().min(0).max(120000).optional().describe('How long to wait for the pipeline before returning what it has so far. Default 25000.'),
            /*
             * Cost and provenance for the CALLING client's own work.
             *
             * The server instructions tell every client to "always report model
             * and tokens_used", and this tool - the only one that starts a run -
             * accepted neither. So Claude Desktop reported them nowhere, every
             * run showed "tokens n/r", and the dashboard's telemetry column was
             * empty by construction. An instruction a tool makes impossible to
             * follow is a bug in the tool.
             *
             * These describe the client's work in reading the brief and calling
             * this tool. The AGENTS' own model and tokens come from upstream, on
             * their own artifacts, and are a different number.
             */
            model: z.string().optional().describe('Which model YOU are, e.g. claude-opus-5. Recorded against the brief artifact.'),
            tokens_used: z.number().int().min(0).optional().describe('Tokens YOUR call consumed. Omitted is recorded as "not reported", never as zero.'),
            source: z.string().optional().describe('Which client you are, e.g. "desktop-ai", "ide-agent". Defaults to agent-manager.')
        },
        async ({ brief, fields, title, project, system_id: systemId, wait_ms: waitMs, model, tokens_used: tokensUsed, source }) => {
            const { system, error } = agentSystems.resolve(systemId, undefined, settings.agentSystems())
            if (error) return errorResult(error)

            const now = new Date().toISOString()
            const owner = resolvePrincipal(context)
            const runTitle = title || brief.split('\n')[0].slice(0, 120)
            const workContext = await store.getWorkContext(owner)
            const resolvedProject = project || (workContext && workContext.project)
            if (!resolvedProject) {
                return errorResult('No programme set. Pass project, or call start_project first.')
            }

            let started
            try {
                started = await agentSystems.startRun(system, brief, fields)
            } catch (e) {
                return errorResult(`${system.id} refused the brief: ${e.message}`)
            }

            const id = makeResourceId('job', runTitle)
            const resource = {
                id,
                title: runTitle,
                type: 'job',
                content: '',
                content_hash: contentHash(''),
                project: resolvedProject,
                practice: system.practice || settings.defaultPracticeFor(owner) || undefined,
                segments: { project: resolvedProject },
                owner,
                author: resolveAuthor(context),
                created: now,
                updated: now,
                updated_at: now,
                version: 1,
                status: statusLib.EXPERIMENTAL,
                // The upstream run is REFERENCED, never joined. Their database stays
                // theirs; this is a typed pointer we resolve through the adapter.
                upstream: { system_id: system.id, run_id: started.upstream_run_id },
                /*
                 * The brief, verbatim, on the run itself.
                 *
                 * Comparing runs on their TITLE does not work: the title is a
                 * truncated brief, and it truncates before the part that
                 * matters. Two briefs identical except "$600" versus "$350"
                 * scored a perfect match with no differing figures, because
                 * neither figure was in either title.
                 */
                brief,
                steps: []
            }

            const addStep = (kind, content, extra = {}) => {
                const order = stepsLib.nextOrder(resource.steps)
                const at = new Date().toISOString()
                resource.steps.push({
                    id: stepsLib.makeStepId(id, order),
                    job_id: id,
                    order,
                    source: 'agent-manager',
                    kind,
                    content,
                    status: statusLib.EXPERIMENTAL,
                    created: at,
                    expires_at: stepsLib.computeExpiry(at),
                    ...extra
                })
            }

            // Artifact 0 is the brief, verbatim. Everything downstream is judged
            // against it, so it is captured before any agent touches it.
            addStep('message', narrate.narrateBrief(brief, system), {
                format: 'md',
                tags: ['brief'],
                // Whoever called this read the brief and decided to start a run;
                // that is their work and their cost, and it rolls up to the run
                // through projectJob.
                source: source || 'agent-manager',
                model,
                tokens_used: tokensUsed
            })

            const waited = await agentSystems.waitForRun(
                system, started.upstream_run_id, { timeoutMs: waitMs == null ? 25000 : waitMs }
            )
            const steps = agentSystems.toSteps(waited.envelope)
            const agents = await agentSystems.discoverAgents(system).catch(() => [])
            /*
             * The Workfront tenant, for deep links in the narration.
             *
             * Read from the registry rather than configured here: whichever
             * Workfront MCP server is registered carries its own instance, so
             * changing tenant is a Settings change and the links follow.
             */
            const workfrontInstance = (() => {
                const servers = mcpServers.list(settings.mcpServers())
                const wf = servers.find(x => x.practice === 'workfront' && x.instance) ||
                    servers.find(x => x.instance)
                return wf ? wf.instance : null
            })()

            const labelFor = (agentId) => {
                const hit = agents.find(a => a.id === agentId)
                return (hit && hit.label) || agentId
            }

            for (const st of steps) {

                // One reader for all four capture paths, so a token figure cannot
                // come to mean different things on different screens - see stageUsage.
                const { tokens, model, modelCalled } = stageUsage(st)

                addStep('doc', narrate.narrateStep(st, labelFor(st.agent_id), { workfrontInstance }), {
                    format: 'md',
                    // Who actually did this. Not the thing that wrote it down.
                    source: st.agent_id,
                    model,
                    tokens_used: tokens,
                    model_called: modelCalled,
                    tags: ['agent', st.agent_id].concat(st.embedded_error ? ['silent-failure'] : []),
                    provenance: {
                        upstream_task_run_id: st.upstream_task_run_id,
                        duration_ms: st.duration_ms,
                        started_at: st.started_at,
                        finished_at: st.finished_at,
                        // Exactly what the upstream sent and received, verbatim.
                        // The narration is a reading of this; this is the evidence.
                        upstream_payload: {
                            agent: st.agent_id,
                            upstream_status: st.upstream_status,
                            input: st.input,
                            output: st.output,
                            metadata: st.metadata
                        }
                    }
                })
            }

            // Where the time went, and what is unresolved. Written every run.
            addStep('decision', narrate.narrateLedger(steps, { labelFor, settled: waited.settled }), {
                format: 'md', tags: ['ledger']
            })

            /*
             * Roll the run up the same way every other save path does.
             *
             * This used to set content/content_hash/step_count by hand and save,
             * which meant the ONE tool that creates agent runs was the one tool
             * that did not compute `agents` or `agent_faults` - so a freshly
             * captured run had five artifacts and no recorded stages, and every
             * progress bar read zero on exactly the runs that had progress. The
             * older runs only looked right because a backfill script had been
             * over them.
             */
            projectJob(resource, resource.steps)
            resource.content_hash = contentHash(resource.content)
            await store.saveResource(resource)

            const faults = steps.filter(st => st.embedded_error)
            const related = await findSimilarRuns(brief, resolvedProject, context)
                .catch(() => ({ similar: [], duplicates: [] }))
            const similar = related.similar
            const duplicates = related.duplicates

            return jsonResult({
                run_id: id,
                upstream: { system_id: system.id, run_id: started.upstream_run_id },
                upstream_status: (waited.envelope && waited.envelope.run && waited.envelope.run.status) || 'unknown',
                settled: waited.settled,
                stages: steps.map(st => ({
                    agent: labelFor(st.agent_id),
                    reported: st.upstream_status,
                    // What the stage ACTUALLY did, which is not always what it reported.
                    actual: st.embedded_error ? 'faulted' : st.upstream_status,
                    failure: st.embedded_error || undefined,
                    ms: st.duration_ms
                })),
                loop_count: agentSystems.loopCount(steps),
                // Stated explicitly so an assistant repeats it to the marketer
                // instead of reporting a green run.
                warnings: faults.map(f => `${labelFor(f.agent_id)} reported "${f.upstream_status}" but its tool call failed: ${f.embedded_error}`)
                    .concat(similar.filter(s => s.differing_figures.length).map(s =>
                        `An APPROVED brief ran before ("${s.title.slice(0, 60)}") and the figures differ: ` +
                        `${s.differing_figures.join(' vs ')}. Confirm which is current before this is built - ` +
                        'two briefs alike in every word but a number are either a revision or a mistake.'
                    ))
                    .concat(duplicates.length
                        ? [`${duplicates.length} UNAPPROVED run(s) look like this brief ` +
                           `(${duplicates.map(d => d.title.slice(0, 40)).join('; ')}). ` +
                           'They are not prior work to reuse - nobody has approved them - but check you are ' +
                           'not raising a second Workfront request for the same thing.']
                        : []),
                /*
                 * WHAT HAPPENS NEXT, AND WHERE.
                 *
                 * The approval is a manual step in Workfront, so the one useful
                 * thing to return is the link and the fact that everything is
                 * now waiting on a person opening it. Without this the caller
                 * had a job in `awaiting_approval` and no idea what to do about
                 * it, which is how an assistant came to invent its own
                 * approve-or-reject question and then mistake the answer for a
                 * Workfront approval that had not happened.
                 */
                waiting_for: (() => {
                    const blocked = agentSystems.blockedOn(waited.envelope)
                    if (!blocked) return undefined
                    const url = blocked.ref ? workfrontLink(blocked.ref.objCode, blocked.ref.objId) : null
                    return {
                        explanation: blocked.awaiting,
                        workfront_url: url || undefined,
                        next: blocked.needs === 'approval'
                            ? 'Give the person the link and stop. Do not offer to continue without the approval, and ' +
                              'do not ask them whether to proceed anyway - nothing can proceed. Once Workfront shows ' +
                              'the approval has cleared, call approve_intake; it re-reads Workfront and will refuse ' +
                              'until then.'
                            : 'This waits on an earlier step, not on a person.'
                    }
                })(),
                // Approved runs only. This is the CX Agentic Graph, and a
                // run in it has been certified by a person.
                similar_runs: similar,
                /*
                 * Unapproved look-alikes. Deliberately NOT called similar_runs:
                 * they are a duplicate-work warning, not knowledge, and an
                 * assistant offered them under the same name recommended reusing
                 * a run whose audience stage had built nothing.
                 */
                possible_duplicates: duplicates,
                note: waited.settled
                    ? undefined
                    : 'The pipeline had not finished when this returned. Call get_intake with the run_id for the rest.'
            })
        }
    )

    server.tool(
        'get_intake',
        'Re-read an intake run from its upstream and return where each stage got to. Use after start_intake when the pipeline had not finished, or to check a run later.',
        {
            run_id: z.string().min(1).describe('The Agent Manager run id returned by start_intake')
        },
        async ({ run_id: runId }) => {
            const resource = await store.getResource(runId)
            if (!resource) return errorResult(`No run found with id '${runId}'`)
            const ref = resource.upstream
            if (!ref || !ref.run_id) return errorResult(`Run '${runId}' has no upstream reference`)
            const { system, error } = agentSystems.resolve(ref.system_id, undefined, settings.agentSystems())
            if (error) return errorResult(error)

            let envelope
            try {
                envelope = await agentSystems.getRun(system, ref.run_id)
            } catch (e) {
                return errorResult(`Could not reach ${system.id}: ${e.message}`)
            }
            const steps = agentSystems.toSteps(envelope)
            const blocked = agentSystems.blockedOn(envelope)
            return jsonResult({
                run_id: runId,
                upstream: ref,
                upstream_status: (envelope && envelope.run && envelope.run.status) || 'unknown',
                ...describeRunState((envelope && envelope.run && envelope.run.status) || 'unknown', blocked),
                loop_count: agentSystems.loopCount(steps),
                stages: steps.map(st => ({
                    agent: st.agent_id,
                    reported: st.upstream_status,
                    actual: st.embedded_error ? 'faulted' : st.upstream_status,
                    failure: st.embedded_error || undefined,
                    ms: st.duration_ms
                })),
                /*
                 * WHY THIS RUN HAS FEWER STAGES THAN YOU EXPECTED.
                 *
                 * Without this a gated run shows one stage and no explanation,
                 * and an absent stage reads exactly like a lost one. It is
                 * neither: the agent was never called, deliberately. Say which
                 * decision is outstanding and name the tool that records it,
                 * because the last time this was left implicit the approval was
                 * recorded against the job instead and the run never moved.
                 */
                waiting_for: blocked
                    ? {
                        map_step: blocked.map_step,
                        gate: blocked.gate_id,
                        agent_not_yet_run: blocked.agent,
                        explanation: blocked.awaiting,
                        record_it_with: blocked.needs === 'approval'
                            ? 'approve_intake (or reject_intake). NOT certify or bake_job - those are about the RECORD of this run, and neither makes the pipeline move.'
                            : 'nothing - this waits on an earlier step, not on a person'
                    }
                    : undefined,
                decisions: agentSystems.gateDecisions(envelope)
            })
        }
    )


    server.tool(
        'answer_intake',
        'Answer the question a job asked and let it carry on - use this whenever a job comes back ' +
        'needs_input. DO NOT call start_intake again to send a corrected or completed brief: that ' +
        'creates a SECOND job for the same piece of work, which is how one brief ended up as two jobs ' +
        'on the bench with nobody able to tell which was real. This re-runs the step that paused, with ' +
        'the answers merged in, and records it on the same job.',
        {
            run_id: z.string().min(1).describe('The job id that came back needs_input'),
            answers: z.record(z.string()).describe('The answers, keyed by the field the question named (e.g. { "request_type": "Audience Build-Only" })')
        },
        async ({ run_id: runId, answers }) => {
            const resource = await store.getResource(runId)
            if (!resource) return errorResult(`No job found with id '${runId}'`)
            const ref = resource.upstream
            if (!ref || !ref.run_id) return errorResult(`'${runId}' is a captured record, not an agent job, so there is no question to answer`)
            const { system, error } = agentSystems.resolve(ref.system_id, undefined, settings.agentSystems())
            if (error) return errorResult(error)

            let result
            try {
                result = await agentSystems.answerRun(system, ref.run_id, answers || {})
            } catch (e) {
                return errorResult(`Could not send the answer to ${system.id}: ${e.message}`)
            }

            const steps = agentSystems.toSteps(result)
            const blocked = agentSystems.blockedOn(result)

            const workfrontInstance = (() => {
                const servers = mcpServers.list(settings.mcpServers())
                const wf = servers.find(x => x.practice === 'workfront' && x.instance) || servers.find(x => x.instance)
                return wf ? wf.instance : null
            })()
            const agentCatalog = await agentSystems.discoverAgents(system).catch(() => [])
            const labelFor = (agentId) => {
                const hit = agentCatalog.find(a => a.id === agentId)
                return (hit && hit.label) || agentId
            }

            // Capture whatever ran because of the answer, onto THIS job. Deduped
            // on the upstream task-run id, so re-running a step appends rather
            // than duplicating, and answering twice cannot double-write.
            let captureNote = null
            try {
                const full = await store.getResource(runId)
                full.steps = full.steps || []
                const already = new Set(
                    full.steps.map(x => x.provenance && x.provenance.upstream_task_run_id).filter(Boolean).map(String)
                )
                full.steps.push(stepsLib.make(runId, stepsLib.nextOrder(full.steps), {
                    kind: 'steering',
                    signal: 'correct',
                    content: `**Answered** ${Object.entries(answers || {}).map(([k, v]) => `${k}: ${v}`).join('; ')}`,
                    format: 'md',
                    source: 'agent-manager',
                    tags: ['answer', 'needs-input'],
                    author: resolveAuthor(context)
                }))
                for (const st of steps) {
                    if (st.upstream_task_run_id && already.has(String(st.upstream_task_run_id))) continue

                    // One reader for all four capture paths, so a token figure cannot
                    // come to mean different things on different screens - see stageUsage.
                    const { tokens, model, modelCalled } = stageUsage(st)
                    full.steps.push(stepsLib.make(runId, stepsLib.nextOrder(full.steps), {
                        kind: 'doc',
                        content: narrate.narrateStep(st, labelFor(st.agent_id), { workfrontInstance }),
                        format: 'md',
                        source: st.agent_id,
                        model,
                        tokens_used: tokens,
                        model_called: modelCalled,
                        tags: ['agent', st.agent_id].concat(st.embedded_error ? ['silent-failure'] : []),
                        author: resolveAuthor(context),
                        provenance: {
                            upstream_task_run_id: st.upstream_task_run_id,
                            duration_ms: st.duration_ms,
                            started_at: st.started_at,
                            finished_at: st.finished_at,
                            upstream_payload: {
                                agent: st.agent_id,
                                upstream_status: st.upstream_status,
                                input: st.input,
                                output: st.output,
                                metadata: st.metadata
                            }
                        }
                    }))
                }
                // projectJob, not the old name. The recipe->job rename happened; these two
        // calls did not, so every capture through them threw ReferenceError into a
        // catch that said nothing - which is why answering a question and advancing
                // a run recorded no stages at all, while approving one did.
                projectJob(full, full.steps, new Date().toISOString())
                full.content_hash = contentHash(full.content)
                await store.saveResource(full)
            } catch (e) {
                /*
                 * Said, not swallowed.
                 *
                 * The Pennsylvania run asked four questions, and the intake
                 * stage that finally created the Workfront request never
                 * reached the record - so approve_intake had no reference to
                 * verify and refused an approval that had really happened. A
                 * capture that fails in silence is how a gap like that survives
                 * all the way to a customer demo.
                 */
                captureNote = `The stages ran, but were not written down: ${e && e.message ? e.message : e}. ` +
                    'get_job will not show them.'
            }

            return jsonResult({
                run_id: runId,
                answered: answers,
                upstream_status: (result && result.run && result.run.status) || 'unknown',
                ...describeRunState((result && result.run && result.run.status) || 'unknown', blocked),
                stages: steps.map(st => ({
                    agent: st.agent_id,
                    reported: st.upstream_status,
                    actual: st.embedded_error ? 'faulted' : st.upstream_status,
                    failure: st.embedded_error || undefined,
                    ms: st.duration_ms
                })),
                waiting_for: blocked
                    ? {
                        explanation: blocked.awaiting,
                        workfront_url: blocked.ref ? workfrontLink(blocked.ref.objCode, blocked.ref.objId) : undefined
                    }
                    : undefined,
                note: captureNote
                    ? `${captureNote} The answer DID reach the pipeline and it moved - this is a failure to record, not to act.`
                    : 'Recorded on the same job, so this brief is one record with a longer history rather than two jobs.'
            })
        }
    )

/**
 * What a run's state MEANS, and what to do about it.
 *
 * The pipeline's own word for "finished a step, waiting to be told to run the
 * next one" is `awaiting_approval`, which reads as though a human owes it an
 * approval. One does not: the only approval in this process is the request in
 * Workfront, at the gate, before Agent 2. After that, a pause is just a pause.
 *
 * An assistant reading the raw status told a marketer to go and approve
 * something after Agent 2 had already run. It was reading exactly what we gave
 * it, so this gives it something truer.
 *
 * `blocked_on` is null when nothing is gated, so the distinction is already in
 * the data - it just was not being said.
 */
function describeRunState (status, blocked) {
    if (blocked) {
        const url = blocked.ref ? workfrontLink(blocked.ref.objCode, blocked.ref.objId) : null
        return {
            state: 'waiting for a named person to approve the request in Workfront',
            next_action: url
                ? `Give this link and stop: ${url}. Once they say they have approved it there, record it with approve_intake. Never offer to approve it yourself.`
                : 'A named person must approve the request in Workfront. Once they say they have, record it with approve_intake.',
            waiting_on_a_human: true
        }
    }
    if (status === 'awaiting_approval') {
        return {
            state: 'paused between steps - a step finished and the next one has not been started',
            next_action: 'Call continue_job. NOTHING is outstanding for a human: the approval at the gate has already happened, and the pipeline stops after every step by design. Do not ask anyone to approve anything here.',
            waiting_on_a_human: false
        }
    }
    if (status === 'needs_input') {
        return {
            state: 'waiting for an answer to a question',
            next_action: 'Read the question, ask the marketer only for that, and send it with answer_intake - not start_intake, which would make a second job.',
            waiting_on_a_human: true
        }
    }
    if (status === 'completed') {
        return {
            state: 'finished - every step has run',
            next_action: 'Nothing to advance. Read the run with get_job to describe what it produced.',
            waiting_on_a_human: false
        }
    }
    if (status === 'failed') {
        return {
            state: 'failed',
            next_action: 'Read the run to see which stage failed and why. Do not retry blindly.',
            waiting_on_a_human: false
        }
    }
    return { state: status, next_action: null, waiting_on_a_human: false }
}

/**
 * What a stage spent, as three possible answers rather than two.
 *
 *   a number             the stage reported what it cost
 *   modelCalled false    the harness called no model on this stage, so there is
 *                        nothing to report and never will be
 *   both undefined       something ran and nobody said what it cost
 *
 * All three used to collapse into "not reported", which drew a deterministic
 * step as a measurement failure and put a tooltip on screen asking a client for
 * a number that does not exist. The harness's agents are parsers and MCP tool
 * calls; the honest figure for them is not zero and not unknown, it is "no
 * model call", and that is worth saying plainly.
 *
 * Read defensively: metadata is inconsistently shaped between stages, and an
 * absent value is recorded as ABSENT rather than zero. "Not reported" and
 * "free" are different claims, and quietly turning one into the other is how a
 * token total stops meaning anything.
 */
function stageUsage (st) {
    const meta = (st && st.metadata && typeof st.metadata === 'object') ? st.metadata : {}
    const usage = (meta.usage && typeof meta.usage === 'object') ? meta.usage : meta
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : undefined
    const tokens = num(usage.tokens_used) ?? num(usage.total_tokens) ?? num(usage.totalTokens) ??
        ((num(usage.input_tokens) ?? 0) + (num(usage.output_tokens) ?? 0) || undefined)
    return {
        tokens,
        model: meta.model || meta.model_id || meta.modelId || usage.model || undefined,
        // Absent on a stage recorded before the harness reported this, and
        // absent is not false: we do not know, so we do not say.
        modelCalled: typeof meta.model_called === 'boolean' ? meta.model_called : undefined
    }
}

/**
 * Narrate whatever ran onto the job, deduped on the upstream task-run id.
 *
 * RETURNS WHAT HAPPENED. This used to swallow every error on the reasoning that
 * the work had happened and the pipeline had moved, so a failure to write it
 * down must not read as the work having failed. True about the status, wrong
 * about the silence: the record IS the product, and a capture that fails
 * without a word looks exactly like a run with nothing to capture. It hid a
 * live bug twice in one day - the NJ audience existed upstream and never
 * reached the record, and every screen said only "server error".
 *
 * @returns {Promise<{added: number, error: string|null}>}
 *
 * Shared by every path that causes an agent to run - the gate decision, an
 * answer, a continue. Three copies of this loop would drift, and the failure
 * mode of drift here is a stage that ran and was never written down, which is
 * precisely the blindness these tools exist to remove.
 */
async function captureStages (runId, system, steps) {
    try {
        const workfrontInstance = (() => {
            const servers = mcpServers.list(settings.mcpServers())
            const wf = servers.find(x => x.practice === 'workfront' && x.instance) || servers.find(x => x.instance)
            return wf ? wf.instance : null
        })()
        const catalog = await agentSystems.discoverAgents(system).catch(() => [])
        const labelFor = (id) => (catalog.find(a => a.id === id) || {}).label || id

        const full = await store.getResource(runId)
        if (!full) return { added: 0, error: `job ${runId} could not be read back` }
        full.steps = full.steps || []
        const already = new Set(
            full.steps.map(x => x.provenance && x.provenance.upstream_task_run_id).filter(Boolean).map(String)
        )
        let added = 0
        for (const st of steps) {
            if (st.upstream_task_run_id && already.has(String(st.upstream_task_run_id))) continue

            // One reader for all four capture paths, so a token figure cannot
            // come to mean different things on different screens - see stageUsage.
            const { tokens, model, modelCalled } = stageUsage(st)
            full.steps.push(stepsLib.make(runId, stepsLib.nextOrder(full.steps), {
                kind: 'doc',
                content: narrate.narrateStep(st, labelFor(st.agent_id), { workfrontInstance }),
                format: 'md',
                source: st.agent_id,
                model,
                tokens_used: tokens,
                model_called: modelCalled,
                tags: ['agent', st.agent_id].concat(st.embedded_error ? ['silent-failure'] : []),
                author: resolveAuthor(context),
                provenance: {
                    upstream_task_run_id: st.upstream_task_run_id,
                    duration_ms: st.duration_ms,
                    started_at: st.started_at,
                    finished_at: st.finished_at,
                    upstream_payload: {
                        agent: st.agent_id,
                        upstream_status: st.upstream_status,
                        input: st.input,
                        output: st.output,
                        metadata: st.metadata
                    }
                }
            }))
            added++
        }
        if (!added) return { added: 0, error: null }
        // projectJob, not the old name. The recipe->job rename happened; these two
        // calls did not, so every capture through them threw ReferenceError into a
        // catch that said nothing - which is why answering a question and advancing
        // a run recorded no stages at all, while approving one did.
        projectJob(full, full.steps, new Date().toISOString())
        full.content_hash = contentHash(full.content)
        await store.saveResource(full)
        return { added, error: null }
    } catch (e) {
        // Reported, not thrown: the pipeline really did move, so this must not
        // read as the work having failed. But it must not be silent either.
        return { added: 0, error: `${e && e.message ? e.message : e}${e && e.stack ? ' | ' + String(e.stack).split('\n')[1].trim() : ''}` }
    }
}

    server.tool(
        'preview_intake',
        'SHOW THE MARKETER WHAT WILL BE FILED, BEFORE IT IS FILED. Takes a brief in plain English and ' +
        'returns exactly what the Workfront request would carry - its title, every field and the values ' +
        'as Workfront will store them, what this form cannot hold, and what it still needs to ask. ' +
        'It creates NOTHING: no request, no project, no email. ' +
        'ALWAYS call this before start_intake, show the result, and ask the marketer to confirm or ' +
        'correct it. Creating the request notifies the queue by email and a correction afterwards is a ' +
        'second version of the truth rather than an edit. The moment they say go, call start_intake ' +
        'once and stop asking - the point of this is to remove waiting, not add a committee.',
        {
            brief: z.string().min(1).describe('The marketer\'s brief, in their own words'),
            known: z.record(z.any()).optional().describe('Anything already settled, e.g. { "campaign_name": "NY Attach Q4" } from an earlier answer'),
            system_id: z.string().optional().describe('Which agent system. Defaults to the only one configured.')
        },
        async ({ brief, known, system_id: systemId }) => {
            const { system, error } = agentSystems.resolve(systemId, undefined, settings.agentSystems())
            if (error) return errorResult(error)
            try {
                const preview = await agentSystems.previewIntake(system, brief, known)
                return jsonResult({
                    ...preview,
                    next: 'Show this to the marketer. If they confirm, call start_intake with the same brief ' +
                          '(and any corrections merged in). If they correct something, preview again - it is free.'
                })
            } catch (e) {
                return errorResult(
                    `Could not preview the brief on ${system.id}: ${e.message}. ` +
                    'Nothing was created. Do not fall back to start_intake to "see what happens" - that files the request.'
                )
            }
        }
    )

    server.tool(
        'continue_job',
        'Advance a job by ONE step. The pipeline stops after every completed step and waits - that is ' +
        'deliberate, the per-agent equivalent of asking before each tool call - so this is what runs the ' +
        'next agent. Use it when a job is awaiting_approval and get_job shows nothing outstanding for a ' +
        'human: the approval at 1.5 is recorded with approve_intake, and everything after it moves with ' +
        'this. It does NOT skip the gate - if the request has not been approved in Workfront it comes ' +
        'back still waiting, and no agent is called.',
        {
            run_id: z.string().min(1).describe('The job id to advance')
        },
        async ({ run_id: runId }) => {
            const resource = await store.getResource(runId)
            if (!resource) return errorResult(`No job found with id '${runId}'`)
            const ref = resource.upstream
            if (!ref || !ref.run_id) return errorResult(`'${runId}' is a captured record, not an agent job, so there is nothing to advance`)
            const { system, error } = agentSystems.resolve(ref.system_id, undefined, settings.agentSystems())
            if (error) return errorResult(error)

            /*
             * A RUN THAT CANNOT BE ADVANCED STILL HAS STAGES TO CAPTURE.
             *
             * Stages are written down by whatever caused them, and each path
             * captures on success - so the LAST stage of a run has nobody to
             * capture it. continue_job runs the final agent, the run completes,
             * and the next call is refused because nothing is left to advance.
             * The stage exists upstream and never reaches the record.
             *
             * That cost us the NJ audience: Agent 3 built it correctly, and the
             * job record had five steps, none of them the audience. Everything
             * anyone could see was an error.
             *
             * So a 409 is not a failure here. The harness attaches the run to
             * its refusal; we capture what is missing and report the outcome.
             */
            let result
            let alreadyDone = false
            try {
                result = await agentSystems.continueRun(system, ref.run_id)
            } catch (e) {
                const terminal = e.status === 409 ||
                    /already finished|no step waiting|nothing to advance/i.test(e.message || '')
                if (!terminal) {
                    return errorResult(`Could not advance ${runId} on ${system.id}: ${e.message}`)
                }
                alreadyDone = true
                // The 409 body carries the run. If an older harness does not
                // send it, read the run outright rather than giving up on it.
                result = (e.body && e.body.run) ? e.body : await agentSystems.getRun(system, ref.run_id).catch(() => null)
                if (!result) {
                    return errorResult(
                        `${runId} has nothing left to advance on ${system.id}, and its state could not be read back: ${e.message}`
                    )
                }
            }

            const steps = agentSystems.toSteps(result)
            const blocked = agentSystems.blockedOn(result)
            const captured = await captureStages(runId, system, steps)

            const status = (result && result.run && result.run.status) || 'unknown'
            return jsonResult({
                run_id: runId,
                upstream_status: status,
                ...describeRunState(status, blocked),
                stages: steps.map(st => ({
                    agent: st.agent_id,
                    reported: st.upstream_status,
                    actual: st.embedded_error ? 'faulted' : st.upstream_status,
                    failure: st.embedded_error || undefined,
                    ms: st.duration_ms
                })),
                waiting_for: blocked
                    ? {
                        explanation: blocked.awaiting,
                        workfront_url: blocked.ref ? workfrontLink(blocked.ref.objCode, blocked.ref.objId) : undefined
                    }
                    : undefined,
                note: alreadyDone
                    ? 'This job has already run every step. Nothing was advanced; any stage that had not been written down yet has been captured now, so read it with get_job.'
                    : (status === 'awaiting_approval' && !blocked
                        ? 'A step finished and the next one is waiting. Nothing is outstanding for a human - call continue_job again to run it.'
                        : undefined),
                detail_captured: captured.error
                    ? `NOT recorded on job ${runId}: ${captured.error}. The stages above DID run - this is a failure to write them down, and get_job will not show them. Say so rather than describing the stages as captured.`
                    : `${captured.added} stage(s) recorded on job ${runId}. Read it with get_job before describing what happened - the stage list here carries statuses and durations only.`
            })
        }
    )

    /* -----------------------------------------------------------------
       The approval at 1.5.

       THIS IS NOT approve_step / certify / bake_job, and the
       difference has already caused one wrong outcome. A person typed
       "approved <workfront id>", the assistant certified the JOB
       into Playbooks, and the run went on sitting at
       awaiting_approval with Agent 2 never invoked. It picked the only
       approve-shaped tool on the server, which was the wrong one.

         approve_intake   a decision about THIS REQUEST. Opens the gate
                          so Agent 2 runs 2.1. The campaign proceeds.
         certify / bake   a decision about the RECORD of a run. Puts it
                          in Playbooks for the Oracle to learn from.
                          Changes nothing about the campaign.
       ----------------------------------------------------------------- */

    /** Shared by approve_intake and reject_intake. */
    async function recordGateDecision ({ runId, workfrontId, decision, reason, decidedBy, evidence }) {
        let id = String(runId || '').trim()
        if (!id && workfrontId) {
            id = await findRunByWorkfrontId(workfrontId, context)
            if (!id) {
                return errorResult(
                    `No run in Agent Manager created Workfront object '${workfrontId}'. ` +
                    'Check the id, or pass run_id instead - list_jobs shows recent runs. ' +
                    'Note that approving something created outside Agent Manager is not ' +
                    'something this can record: there is no pipeline waiting on it.'
                )
            }
        }
        if (!id) return errorResult('Pass either run_id or workfront_id.')

        const resource = await store.getResource(id)
        if (!resource) return errorResult(`No run found with id '${id}'`)
        const ref = resource.upstream
        if (!ref || !ref.run_id) {
            return errorResult(
                `'${id}' is a captured record, not an agent run, so no pipeline is waiting on it. ` +
                'If you meant to approve the RECORD for Playbooks, that is certify - a different thing.'
            )
        }
        const { system, error } = agentSystems.resolve(ref.system_id, undefined, settings.agentSystems())
        if (error) return errorResult(error)

        /*
         * The decision carries a name, and it defaults to the caller rather
         * than to a label like "system".
         *
         * When the audience turns out wrong at 3.4, "who approved this brief"
         * has to have an answer. A field always populated with a placeholder is
         * worse than an empty one, because it looks answered.
         */
        /*
         * THE APPROVAL IS VERIFIED, NOT ASSERTED.
         *
         * Only for an approval - a rejection needs no Workfront confirmation,
         * because rejecting sends the request back for correction and the worst
         * case is a wasted round trip rather than a campaign proceeding on a
         * false record.
         */
        if (decision === 'approved') {
            /*
             * The Workfront record, from the rollup OR from the artifacts.
             *
             * workfront_refs is a projection added later, so jobs captured
             * before it exists do not have it. Reading only the projection
             * would make every one of those jobs permanently unapprovable -
             * a verification step that cannot find the thing to verify is just
             * an outage. The artifacts always carry the reference.
             */
            let refs = (resource.workfront_refs && resource.workfront_refs.length)
                ? resource.workfront_refs
                : (resource.steps || []).flatMap(st => {
                    const payload = st.provenance && st.provenance.upstream_payload
                    return payload ? narrate.findWorkfrontRefs(payload.output) : []
                })

            /*
             * THIRD SOURCE: ASK THE PIPELINE WHAT IT CREATED.
             *
             * Our record can be incomplete. On the Pennsylvania run intake ran
             * four times - once per question - and the job holds the first
             * attempt, which created nothing, and not the last, which created
             * the request. So both the rollup and the artifact scan came back
             * empty and the approval was refused for a request that existed and
             * had been approved.
             *
             * The upstream run is the authority on what it created, so it is
             * asked. A verifier that only works when our own bookkeeping is
             * complete is a second thing to fail in front of a customer.
             */
            /*
             * resource.upstream, not `ref` - a later `const ref` in this block
             * shadows the outer one, so naming it here hits the temporal dead
             * zone and throws "Cannot access 'ref' before initialization".
             * node --check does not see that; only running it does.
             */
            const upstreamRef = resource.upstream
            if (!refs.length && upstreamRef && upstreamRef.run_id) {
                try {
                    const { system } = agentSystems.resolve(upstreamRef.system_id, undefined, settings.agentSystems())
                    if (system) {
                        const upstream = await agentSystems.getRun(system, upstreamRef.run_id)
                        for (const st of agentSystems.toSteps(upstream)) {
                            for (const r of narrate.findWorkfrontRefs(st.output)) {
                                if (!refs.some(x => x.objId === r.objId)) refs.push(r)
                            }
                        }
                    }
                } catch (e) {
                    // Fall through to the error below, which already says what
                    // could not be found. A failed read here is not a new fact.
                }
            }
            // The ISSUE is what carries the approval; a project created later at
            // review time does not. Prefer it explicitly rather than taking
            // whichever reference happens to be first.
            const ref = refs.find(r => r.objCode === 'OPTASK') || refs[0] || null
            if (!ref) {
                return errorResult(
                    `Cannot verify an approval for '${id}': no Workfront record was found against it - not in ` +
                    'the rollup, not in its artifacts, and not in the pipeline run itself. So there is nothing ' +
                    'whose approval state can be read. A job that created no Workfront request has nothing to ' +
                    'approve; if you are looking at a request in Workfront that this job created, pass its id ' +
                    'directly as workfront_id.'
                )
            }

            const state = await workfrontApprovalState(ref.objCode, ref.objId)
            const link = workfrontLink(ref.objCode, ref.objId)

            if (state.approved !== true) {
                return errorResult(
                    `NOT APPROVED. ${state.detail}\n\n` +
                    `Approve it in Workfront here: ${state.url || link || `${ref.objCode} ${ref.objId} (no tenant configured, so no link)`}\n\n` +
                    'This is a manual step and it is deliberately the one thing this tool will not do for you. ' +
                    'It does not accept "the user said to approve it": a person clicking Approve in Workfront is ' +
                    'what an approval IS, and reading it back from Workfront is the only way to know it happened. ' +
                    'Do not retry this call, do not look for another tool, and do not record the approval some other ' +
                    'way - wait, and call again once Workfront shows it cleared.'
                )
            }
        }

        const who = String(decidedBy || '').trim() || resolveAuthor(context)
        if (!who || who === 'unknown') {
            return errorResult(
                'Cannot record an approval with nobody\'s name on it. Sign in, or pass ' +
                'decided_by with the name of the person who actually decided.'
            )
        }

        let result
        try {
            result = await agentSystems.decideGate(system, ref.run_id, {
                decision,
                decided_by: who,
                reason: reason || null,
                evidence: { source: evidence || 'recorded through Agent Manager', recorded_by: resolveAuthor(context) }
            })
        } catch (e) {
            return errorResult(`Could not record the decision on ${system.id}: ${e.message}`)
        }

        const steps = agentSystems.toSteps(result)
        const blocked = agentSystems.blockedOn(result)

        /*
         * The Workfront tenant, for deep links in the narration. Read from the
         * registry so changing tenant is a Settings change, as elsewhere.
         */
        const workfrontInstance = (() => {
            const servers = mcpServers.list(settings.mcpServers())
            const wf = servers.find(x => x.practice === 'workfront' && x.instance) ||
                servers.find(x => x.instance)
            return wf ? wf.instance : null
        })()
        const agentCatalog = await agentSystems.discoverAgents(system).catch(() => [])
        const labelFor = (agentId) => {
            const hit = agentCatalog.find(a => a.id === agentId)
            return (hit && hit.label) || agentId
        }

        /*
         * Capture the decision on the run as a steering artifact.
         *
         * A human steering a run is the most valuable thing in this store, and
         * an approval is the plainest instance of it. Recording it here means
         * the run's own history shows who let it through, without anyone having
         * to join across to the harness's tables.
         */
        try {
            const full = await store.getResource(id)
            full.steps = full.steps || []

            /*
             * Narrate every stage that is not already on the record.
             *
             * Deduped on the upstream's own task_run id, so calling this twice -
             * or resuming a job more than once - cannot double-write a stage.
             * That id is the only stable identity a stage has across the
             * boundary; matching on agent name would collapse the two runs of an
             * agent that legitimately ran twice.
             */
            const already = new Set(
                full.steps
                    .map(x => x.provenance && x.provenance.upstream_task_run_id)
                    .filter(Boolean)
                    .map(String)
            )
            for (const st of steps) {
                if (st.upstream_task_run_id && already.has(String(st.upstream_task_run_id))) continue

                // One reader for all four capture paths, so a token figure cannot
                // come to mean different things on different screens - see stageUsage.
                const { tokens, model, modelCalled } = stageUsage(st)

                full.steps.push(stepsLib.make(id, stepsLib.nextOrder(full.steps), {
                    kind: 'doc',
                    content: narrate.narrateStep(st, labelFor(st.agent_id), { workfrontInstance }),
                    format: 'md',
                    source: st.agent_id,
                    model,
                    tokens_used: tokens,
                    model_called: modelCalled,
                    tags: ['agent', st.agent_id].concat(st.embedded_error ? ['silent-failure'] : []),
                    author: resolveAuthor(context),
                    provenance: {
                        upstream_task_run_id: st.upstream_task_run_id,
                        duration_ms: st.duration_ms,
                        started_at: st.started_at,
                        finished_at: st.finished_at,
                        // The narration is a reading of this; this is the evidence.
                        upstream_payload: {
                            agent: st.agent_id,
                            upstream_status: st.upstream_status,
                            input: st.input,
                            output: st.output,
                            metadata: st.metadata
                        }
                    }
                }))
            }

            full.steps.push(stepsLib.make(id, stepsLib.nextOrder(full.steps), {
                kind: 'steering',
                signal: decision === 'approved' ? 'affirm' : 'reject',
                content:
                    `**1.5 - ${decision === 'approved' ? 'Approved' : 'Rejected'}** by ${who}.\n\n` +
                    (reason ? `> ${reason}\n\n` : '') +
                    (decision === 'approved'
                        ? 'This is the process gate, not a job approval. Phase 2 may now run: ' +
                          '2.1 converts the request to a project and writes the brief onto the project form.'
                        : 'This is the 1.5a rework path. Agent 2 translates the reason above into the ' +
                          'specific field to change, for the marketer to confirm.'),
                format: 'md',
                source: 'agent-manager',
                tags: ['gate', '1.5', decision],
                author: resolveAuthor(context)
            }))
            projectJob(full, full.steps, new Date().toISOString())
            full.content_hash = contentHash(full.content)
            await store.saveResource(full)
        } catch (e) {
            // The decision is recorded upstream and the pipeline has already
            // moved. Failing to ALSO capture it here must not read as the
            // approval having failed.
        }

        const ran = steps.map(st => ({
            agent: st.agent_id,
            reported: st.upstream_status,
            actual: st.embedded_error ? 'faulted' : st.upstream_status,
            failure: st.embedded_error || undefined,
            ms: st.duration_ms
        }))

        return jsonResult({
            run_id: id,
            recorded: { gate: '1.5', decision, decided_by: who, reason: reason || null },
            upstream_status: (result && result.run && result.run.status) || 'unknown',
            // What ran BECAUSE of this decision.
            stages: ran,
            waiting_for: blocked
                ? {
                    explanation: blocked.awaiting,
                    // The record to open, as a link. A person told to approve
                    // something and not told where is a person who does not.
                    workfront_url: blocked.ref ? workfrontLink(blocked.ref.objCode, blocked.ref.objId) : undefined
                }
                : undefined,
            /*
             * Say that the detail is now ON the job, because the last time it was
             * not, a connected assistant correctly reported that it could not see
             * what Agents 2 and 3 had done and had to advise checking Workfront
             * by hand.
             */
            detail_captured: `Every stage this decision caused is now recorded on job ${id} as its own artifact, ` +
                'with the agent\'s verbatim output attached. Read it with get_job before describing what happened - ' +
                'the stage list below carries statuses and durations only.',
            what_this_did: decision === 'approved'
                ? 'Opened the gate at 1.5, so the pipeline moved into phase 2. Read `stages` for what ' +
                  'Agent 2 actually did - 2.1 creates the project and writes the brief onto the project ' +
                  'form, then 2.3 checks whether the audience already exists. This did NOT certify the ' +
                  'run into Playbooks; that is certify, and it is a separate decision.'
                : 'Sent the request down 1.5a. Agent 2 has triaged the reason into specific field changes ' +
                  'for the marketer to confirm - confirming a redraft is a human step by design.'
        })
    }

    server.tool(
        'approve_intake',
        'RECORDS AN APPROVAL THAT HAS ALREADY HAPPENED IN WORKFRONT. Use it only after a human tells you ' +
        'they have approved the request - including when they name a Workfront object id, e.g. ' +
        '"approved 6aac001e...". It opens the gate so Agent 2 runs, converting the request into a project ' +
        'that carries the brief, and the campaign proceeds. ' +
        'NEVER OFFER TO APPROVE, and never present approving as a choice the person can ask you to make - ' +
        'not "shall I approve it", not "approve and continue anyway". The approval is a named person ' +
        'clicking Approve in Workfront, and there is nothing you can do in its place. When a job is ' +
        'waiting here, the whole of the correct response is: give the Workfront link, say plainly that it ' +
        'needs their approval there, and stop. Then wait to be told. ' +
        'It does NOT approve anything inside Workfront: a named person clicks Approve in Workfront\'s own ' +
        'Approvals tab, and this records that they did so the pipeline can move. ' +
        'DO NOT confuse this with certify / bake_job / approve_step - those promote the RECORD of a run ' +
        'into Playbooks for the Oracle to learn from, and none of them makes the pipeline advance. ' +
        'Do not repeat our step numbers - 1.5, 2.1, 2.7 - to anyone. They are coordinates on an internal ' +
        'process map and mean nothing to a marketer. Say what is happening instead. ' +
        'If a job is sitting at awaiting_approval, this is the tool that moves it. IT VERIFIES: it reads the record back from Workfront and REFUSES unless Workfront itself reports the approval has cleared. Saying that the user approved it is not enough and never will be - the last time this was taken on trust, a job reported three completed stages while the Workfront request was still Pending Approval.',
        {
            run_id: z.string().optional().describe('The Agent Manager run id from start_intake'),
            workfront_id: z.string().optional().describe('The Workfront object id the human named, e.g. 6aac001e0008d40c0ba4389f1247ad36. Either this or run_id.'),
            decided_by: z.string().optional().describe('The named human who approved. Defaults to the authenticated caller - pass this only when relaying someone else\'s decision, and name them.'),
            note: z.string().optional().describe('How the approval happened, e.g. "approved in the Workfront Approvals tab, stage 1"')
        },
        async ({ run_id: runId, workfront_id: workfrontId, decided_by: decidedBy, note }) =>
            recordGateDecision({ runId, workfrontId, decision: 'approved', reason: note || null, decidedBy, evidence: note })
    )

    server.tool(
        'reject_intake',
        'RECORDS A REJECTION THAT HAS ALREADY HAPPENED IN WORKFRONT - the request goes back to the ' +
        'marketer as rework. Same rule as approve_intake: never offer to reject on anyone\'s behalf. ' +
        'Agent 2 reads the reason and translates it into the specific missing field or wrong data source, ' +
        'then proposes a redraft for the marketer to confirm. A reason is REQUIRED: an unexplained ' +
        'rejection sends the marketer back to a form with eleven fields to guess at, which is the ' +
        'unbounded rework loop this pipeline exists to close.',
        {
            run_id: z.string().optional().describe('The Agent Manager run id from start_intake'),
            workfront_id: z.string().optional().describe('The Workfront object id the human named. Either this or run_id.'),
            reason: z.string().min(1).describe('What is wrong, in the reviewer\'s own words. This is the input to the triage - the more specific, the fewer round trips.'),
            decided_by: z.string().optional().describe('The named human who rejected it. Defaults to the authenticated caller.')
        },
        async ({ run_id: runId, workfront_id: workfrontId, reason, decided_by: decidedBy }) =>
            recordGateDecision({ runId, workfrontId, decision: 'rejected', reason, decidedBy, evidence: 'rejected through Agent Manager' })
    )

    /* -----------------------------------------------------------------
       MCP servers. Adobe ships one per product - Workfront, AEM, AEP -
       and more will arrive. Each is a registry entry with an endpoint,
       editable here and in Settings, never a branch in code.
       ----------------------------------------------------------------- */

    server.tool(
        'list_mcp_servers',
        'List the MCP servers Agent Manager can reach - Workfront, AEM, AEP and any other. Shows each one\'s endpoint, domain, whether it is active and whether its credential is configured. Never returns the credential itself.',
        {},
        async () => {
            const overrides = settings.mcpServers()
            const servers = mcpServers.listSafe(overrides)
            return jsonResult(servers.map(s => ({
                ...s,
                ready: mcpServers.readiness(mcpServers.get(s.id, overrides)).ready,
                blocked_because: mcpServers.readiness(mcpServers.get(s.id, overrides)).reason
            })))
        }
    )

    server.tool(
        'set_mcp_server',
        'ADMIN: add or update an MCP server. Use this to point Agent Manager at a new Adobe MCP - Workfront, AEM, AEP - without a deploy. Only the fields you pass are changed. Put real tokens in the environment and reference them as ${ENV_VAR} rather than pasting them here.',
        {
            id: z.string().min(1).describe('Stable key, e.g. workfront-adobe'),
            label: z.string().optional().describe('What people see'),
            practice: z.string().optional().describe('Domain it belongs to: workfront | aep | aem'),
            endpoint: z.string().optional().describe('Base URL of the MCP server'),
            auth: z.string().optional().describe('Authorization header value, or ${ENV_VAR} to read it from the environment. Blank when the server owns auth.'),
            instance: z.string().optional().describe('Tenant, where the server needs one (Workfront)'),
            active: z.boolean().optional().describe('Off leaves it registered but unused'),
            disconnect: z.boolean().optional().describe('Sign out: clears the stored credential and any OAuth tokens for this server, and switches it off'),
            gateway: z.boolean().optional().describe('Re-expose the tools of this server through Agent Manager, so a connected client (Claude) can call them directly. Names are prefixed with the server id, so an upstream tool can never shadow a native one.')
        },
        async (args) => {
            if (!callerHasRole(context, 'admin')) {
                return errorResult('Only an admin may change MCP servers.')
            }
            const overrides = settings.mcpServers()
            const existing = overrides.find(s => s.id === args.id) || { id: args.id }
            const merged = { ...existing }
            for (const [k, v] of Object.entries(args)) if (v !== undefined) merged[k] = v
            if (args.disconnect) {
                /*
                 * Sign out. The entry stays registered - forgetting the server
                 * entirely is a different, louder action than forgetting its
                 * token.
                 *
                 * AND IT IS RECORDED. A working Workfront token disappeared
                 * during a session and there was no way to tell whether a person
                 * had clicked Sign out or something in this code had called
                 * disconnect. Losing a credential is bad; not being able to say
                 * what lost it is worse, because the next hour goes on
                 * speculation instead of on the cause.
                 */
                delete merged.disconnect
                const had = !!existing.auth || !!(existing.oauth && existing.oauth.connected_at)
                merged.auth = null
                merged.oauth = null
                merged.active = false
                merged.disconnected_at = new Date().toISOString()
                merged.disconnected_by = resolvePrincipal(context)
                if (had) {
                    // No module logger here; console is what the host captures.
                    console.warn(
                        `[credential] ${args.id} signed out by ${merged.disconnected_by} at ${merged.disconnected_at} - ` +
                        'stored token and OAuth state discarded, server switched off'
                    )
                }
            }

            const next = overrides.filter(s => s.id !== args.id).concat([merged])
            const current = await store.getSettingsOverride()
            const stored = await store.saveSettingsOverride({ ...current, mcp_servers: next })
            settings._setCache(stored)

            const resolved = mcpServers.get(args.id, next)
            const state = mcpServers.readiness(resolved)
            return jsonResult({
                saved: mcpServers.listSafe(next).find(s => s.id === args.id),
                ready: state.ready,
                blocked_because: state.reason
            })
        }
    )

    server.tool(
        'list_gateway_tools',
        'What Agent Manager is re-exposing on behalf of other MCP servers. These are the tools a connected client sees IN ADDITION to the native ones, named <server-id>__<tool>. Turn a server on with set_mcp_server({id, gateway: true}). A server that did not answer contributes no tools and says so here rather than silently vanishing.',
        {},
        async () => {
            const catalog = await mcpGateway.catalog(settings.mcpServers())
            return jsonResult({
                servers: catalog.servers,
                tool_count: catalog.tools.length,
                tools: catalog.tools.map(t => ({ name: t.name, from: t._server, upstream_name: t._tool, description: t.description }))
            })
        }
    )

    server.tool(
        'set_agent_system',
        'ADMIN: add or update an agent system - the upstream that actually executes agents, e.g. Chauncey\'s Xfinity Creative Intake harness. Use this to wire a second harness (an agentic AEP one, say) without a deploy. Only the fields you pass are changed. Agent names are never set here: they are read from the system\'s own catalog at agents_path, so the upstream stays the single source of truth for what its agents are called.',
        {
            id: z.string().min(1).describe('Stable key, e.g. agentic-harness'),
            label: z.string().optional().describe('What people see'),
            practice: z.string().optional().describe('Domain it belongs to: workfront | aep | aem'),
            base_url: z.string().optional().describe('Where the harness answers'),
            auth: z.string().optional().describe('Authorization header value, or ${ENV_VAR} to read it from the environment'),
            mcp_endpoint: z.string().optional().describe('Which MCP estate the harness itself calls, where that is knowable'),
            mcp_server_id: z.string().optional().describe('Which registered MCP server backs it (see list_mcp_servers)'),
            agents_path: z.string().optional().describe('Path to its own agent catalog, e.g. /api/tasks'),
            start_path: z.string().optional().describe('Path that starts a run, e.g. /api/runs'),
            run_path: z.string().optional().describe('Path that reads a run, e.g. /api/runs/{run_id}'),
            input_key: z.string().optional().describe('The field the brief goes in, e.g. brief'),
            input_envelope: z.string().optional().describe('Wrapper object around the input, e.g. input. Omit for top level.'),
            active: z.boolean().optional().describe('Off leaves it registered but unused')
        },
        async (args) => {
            if (!callerHasRole(context, 'admin')) {
                return errorResult('Only an admin may change agent systems.')
            }
            const overrides = settings.agentSystems()
            const existing = overrides.find(x => x.id === args.id) || { id: args.id }
            const mergedEntry = { ...existing }
            for (const [k, v] of Object.entries(args)) if (v !== undefined) mergedEntry[k] = v

            const next = overrides.filter(x => x.id !== args.id).concat([mergedEntry])
            const current = await store.getSettingsOverride()
            const stored = await store.saveSettingsOverride({ ...current, agent_systems: next })
            settings._setCache(stored)

            return jsonResult({ saved: agentSystems.list(next).find(x => x.id === args.id) })
        }
    )

    server.tool(
        'check_agent_system',
        'Ask an agent system for its own agent catalog. Use it to verify a harness actually answers before pointing an intake at it, and to see what its agents are really called rather than guessing. Reported as a failure when it does not answer - an unreachable harness and a harness with no agents are different problems.',
        {
            id: z.string().min(1).describe('The system id, from list_agent_systems')
        },
        async ({ id }) => {
            const overrides = settings.agentSystems()
            const sys = agentSystems.get(id, overrides)
            if (!sys) return errorResult(`No agent system registered with id '${id}'`)
            try {
                const agents = await agentSystems.discoverAgents(sys)
                return jsonResult({
                    id,
                    base_url: sys.base_url,
                    agents_path: sys.agents_path,
                    agent_count: agents.length,
                    agents: agents.map(a => ({ id: a.id, label: a.label, owner: a.owner || null })),
                    mcp_endpoint: sys.mcp_endpoint || null,
                    mcp_server_id: sys.mcp_server_id || null
                })
            } catch (e) {
                return errorResult(`${id} did not answer: ${e.message}`)
            }
        }
    )

    server.tool(
        'check_mcp_server',
        'Ask an MCP server what tools it exposes. Use it to verify a server actually answers before pointing an agent at it, and to find the real name of a tool rather than guessing one.',
        {
            id: z.string().min(1).describe('The server id, from list_mcp_servers'),
            contains: z.string().optional().describe('Only return tool names containing this string')
        },
        async ({ id, contains }) => {
            const overrides = settings.mcpServers()
            const srv = mcpServers.get(id, overrides)
            if (!srv) return errorResult(`No MCP server registered with id '${id}'`)
            try {
                const tools = await mcpServers.listTools(srv)
                const names = tools.map(t => t.name).filter(n => !contains || n.includes(contains))
                return jsonResult({ id, endpoint: srv.endpoint, tool_count: tools.length, tools: names.slice(0, 200) })
            } catch (e) {
                // Reported as a failure, not as an empty list. An unreachable
                // server and a server with no tools are different problems.
                return errorResult(`${id} did not answer: ${e.message}`)
            }
        }
    )

    server.tool(
        'append_step',
        'Append the next ordered Step to a Job (started with start_job) - the atomic capture primitive. Steps are appended in order and never reshuffled. Text kinds (message/code/decision/doc/handoff/config, and diagram when captured as mermaid/svg source) use "content"; image/rendered-diagram kinds use "asset" (base64 + mime_type) - give both together to keep a diagram\'s source alongside its rendered image. Use kind "steering" with a "signal" (affirm/reject/correct) to capture how a human steered the work (a correction is prime capture). New steps are EXPERIMENTAL and expire after the retention window unless approved (approve_step/approve_steps).',
        {
            job_id: z.string().min(1).describe('The job id to append to, as returned by start_job'),
            source: z.string().optional().describe('Free text: which client produced this step, e.g. "desktop-ai", "ide-agent", "cli-agent" - vendor-neutral; defaults to "unknown"'),
            model: z.string().optional().describe('Free-text model identifier that produced this step (vendor-neutral), e.g. "opus-4.8"'),
            kind: z.enum(['message', 'code', 'diagram', 'image', 'decision', 'doc', 'handoff', 'config', 'steering', 'other']).describe('What kind of output this step captures'),
            signal: z.enum(['affirm', 'reject', 'correct']).optional().describe('For kind "steering": affirm (approved/allowed), reject (denied), or correct (edited/redirected)'),
            content: z.string().optional().describe('Text content. Required unless "asset" is given.'),
            asset: z.object({
                data: z.string().min(1).describe('Base64-encoded binary content'),
                mime_type: z.string().min(1).describe('MIME type, e.g. image/png, image/svg+xml')
            }).optional().describe('Binary artifact (image, or a rendered diagram) - stored as a blob asset'),
            format: z.string().optional().describe('Content format hint, e.g. md, mermaid, svg, png, diff'),
            language: z.string().optional().describe('For kind "code": the programming language'),
            diff: z.string().optional().describe('For kind "code": an optional unified diff'),
            tokens_used: z.number().int().nonnegative().optional().describe('Tokens this step consumed (best-effort, AI-reported)'),
            tags: z.array(z.string()).optional().describe('Optional tags for discovery'),
            provenance: z.record(z.string(), z.any()).optional().describe('Optional free-form provenance (session id, tool version, anchor...)')
        },
        async ({ job_id: jobId, source, model, kind, signal, content, asset, format, language, diff, tokens_used: tokensUsed, tags, provenance }) => {
            // A steering step is self-describing via its signal; other kinds need content or an asset.
            if (!content && !asset && kind !== 'steering') {
                return errorResult('Provide "content" or "asset" - a step needs at least one')
            }
            const resource = await store.getResource(jobId)
            if (!resource) {
                return errorResult(`No job found with id '${jobId}' - start one with start_job`)
            }
            if (!callerCanWrite(resource, context)) return notWritableError(jobId)
            /*
             * Appending to an AGENT run is how a human's steering gets recorded,
             * and that is the most valuable thing in the store - so it is allowed
             * whatever the mode. Appending to anything else is general capture.
             *
             * The check is on the TARGET, not the caller: it does not matter
             * which client is asking, it matters whether the thing being added to
             * is a record of agent work.
             */
            if (settings.captureMode() !== 'open' && !isAgentRunResource(resource)) {
                return refuseCapture(`adding an artifact to "${resource.title || jobId}", which is not an agent run`)
            }
            const steps = stepsLib.ensureSteps(resource)
            const order = stepsLib.nextOrder(steps)
            const now = new Date().toISOString()
            const owner = resolvePrincipal(context)
            const stepId = stepsLib.makeStepId(jobId, order)

            let assetPointer
            if (asset) {
                assetPointer = await store.saveAsset(stepId, asset.data, asset.mime_type)
            }

            const step = {
                id: stepId,
                job_id: jobId,
                order,
                source: source || 'unknown',
                model,
                kind,
                signal: kind === 'steering' ? signal : undefined,
                content,
                asset: assetPointer,
                language,
                diff,
                format,
                owner,
                tokens_used: tokensUsed,
                tokens_last: tokensUsed,
                provenance,
                created: now,
                updated: now,
                status: statusLib.EXPERIMENTAL,
                expires_at: stepsLib.computeExpiry(now),
                tags
            }

            const nextSteps = [...steps, step]
            projectJob(resource, nextSteps, now)
            await store.saveResource(resource)

            return jsonResult({ id: step.id, job_id: jobId, order, kind, signal: step.signal, status: step.status, expires_at: step.expires_at })
        }
    )

    /**
     * Shared step-approval handler for approve_step/approve_steps (D45).
     * @param {string[]} stepIds
     * @param {string} [note]
     * @returns {Promise<object[]>} one result per requested step id
     */
    async function approveStepsHandler (stepIds, note) {
        const now = new Date().toISOString()
        const principal = resolvePrincipal(context)
        const results = []
        const byJob = new Map()
        for (const stepId of stepIds) {
            const parsed = stepsLib.parseStepId(stepId)
            if (!parsed) {
                results.push({ id: stepId, error: `Not a valid step id: '${stepId}'` })
                continue
            }
            if (!byJob.has(parsed.jobId)) byJob.set(parsed.jobId, [])
            byJob.get(parsed.jobId).push(stepId)
        }

        for (const [jobId, ids] of byJob) {
            const resource = await store.getResource(jobId)
            if (!resource) {
                for (const stepId of ids) results.push({ id: stepId, error: `No job found for step '${stepId}'` })
                continue
            }
            if (!callerCanWrite(resource, context)) {
                for (const stepId of ids) results.push({ id: stepId, error: `Refused: '${jobId}' is not yours to change` })
                continue
            }
            const steps = stepsLib.ensureSteps(resource)
            let changed = false
            for (const stepId of ids) {
                const step = steps.find(s => s.id === stepId)
                if (!step) {
                    results.push({ id: stepId, error: `No step found with id '${stepId}'` })
                    continue
                }
                if (step.status === 'discarded') {
                    results.push({ id: stepId, error: 'Cannot approve a discarded step' })
                    continue
                }
                step.status = statusLib.APPROVED
                step.approved_by = principal
                step.approved_at = now
                if (note) step.approval_note = note
                step.expires_at = undefined
                changed = true
                results.push({ id: stepId, status: statusLib.APPROVED, approved_by: principal, approved_at: now })
            }
            if (changed) {
                projectJob(resource, steps, now)
                await store.saveResource(resource)
            }
        }
        return results
    }

    server.tool(
        'approve_step',
        'Certify a single Step as a human consent, promoting it to "approved" - it joins its job\'s Playbooks view (in order) and is kept forever. Records approved_by/at and an optional note. This is about the RECORD of a run, NOT the process approval at 1.5 - it does not make the pipeline advance. A run sitting at awaiting_approval is moved by approve_intake.',
        {
            step_id: z.string().min(1).describe('The step id, as returned by append_step/get_job/list_steps'),
            note: z.string().optional().describe('Optional consent note')
        },
        async ({ step_id: stepId, note }) => {
            const [result] = await approveStepsHandler([stepId], note)
            return result.error ? errorResult(result.error) : jsonResult(result)
        }
    )

    server.tool(
        'approve_steps',
        'Certify several Steps at once (same effect as calling approve_step repeatedly, one consent note for all of them).',
        {
            step_ids: z.array(z.string().min(1)).min(1).describe('The step ids to approve'),
            note: z.string().optional().describe('Optional consent note applied to all of them')
        },
        async ({ step_ids: stepIds, note }) => jsonResult(await approveStepsHandler(stepIds, note))
    )

    server.tool(
        'discard_step',
        'Discard a Step - it is excluded from the job\'s full and approved views (e.g. a draft that turned out not to be useful). An already-approved step cannot be discarded (it is kept forever once certified). Idempotent.',
        {
            step_id: z.string().min(1).describe('The step id to discard')
        },
        async ({ step_id: stepId }) => {
            const parsed = stepsLib.parseStepId(stepId)
            if (!parsed) return errorResult(`Not a valid step id: '${stepId}'`)
            const resource = await store.getResource(parsed.jobId)
            if (!resource) return errorResult(`No job found for step '${stepId}'`)
            if (!callerCanWrite(resource, context)) return notWritableError(parsed.jobId)
            const steps = stepsLib.ensureSteps(resource)
            const step = steps.find(s => s.id === stepId)
            if (!step) return errorResult(`No step found with id '${stepId}'`)
            if (statusLib.isApproved(step.status)) {
                return errorResult(`Step '${stepId}' is already approved - approved steps are kept forever and cannot be discarded`)
            }
            step.status = 'discarded'
            step.expires_at = undefined
            projectJob(resource, steps, new Date().toISOString())
            await store.saveResource(resource)
            return jsonResult({ id: stepId, status: 'discarded' })
        }
    )

    server.tool(
        'get_job',
        'Read a Job as its ordered Steps. view="full" (default) returns every non-discarded step in order - the full working log, including experimental drafts (the Test Kitchen view). view="approved" returns only approved steps in order - the composed, followable cookbook job. Image/diagram asset steps include their base64 data.',
        {
            id: z.string().min(1).describe('The job id'),
            view: z.enum(['full', 'approved']).optional().describe('Defaults to "full"')
        },
        async ({ id, view }) => {
            const resource = await store.getResource(id)
            if (!resource) {
                return errorResult(`No job found with id '${id}'`)
            }
            if (!callerCanRead(resource, context)) return notVisibleError(id)
            const steps = stepsLib.ensureSteps(resource)
                .filter(s => s.status !== 'discarded')
                .sort((a, b) => a.order - b.order)
            const filtered = view === 'approved' ? steps.filter(s => statusLib.isApproved(s.status)) : steps
            const hydrated = await Promise.all(filtered.map(async s => {
                if (!s.asset || !s.asset.path) return s
                const data = await store.readAssetBase64(s.asset.path)
                return { ...s, asset: { ...s.asset, data } }
            }))
            return jsonResult({
                id: resource.id,
                title: resource.title,
                project: resource.project,
                segments: resource.segments,
                owner: resource.owner,
                status: resource.status,
                created: resource.created,
                updated: resource.updated_at || resource.updated,
                version: resource.version,
                view: view || 'full',
                // D89: the rollups the catalog already carries. get_job is the primary
                // read-one-job tool, and it was the only view that could not answer "what stage
                // is this at, what did it cost, which models produced it" without a second call.
                practice: resource.practice,
                baked: resource.baked === true,
                cx_approved: resource.cx_approved === true,
                step_count: resource.step_count,
                tokens_used: resource.tokens_used,
                models_used: resource.models_used || [],
                // The journey this run actually took, and where it lied about it.
                agents: resource.agents || [],
                agent_faults: resource.agent_faults || [],
                assigned_to: resource.assigned_to || [],
                steps: hydrated
            })
        }
    )

    server.tool(
        'list_jobs',
        'List Jobs (metadata only - title/project/status/owner/version/practice, no step content), optionally filtered by project, status and/or practice. Excludes handoff-prompts (task briefs, not jobs). Filter by practice to see just one discipline\'s knowledge (e.g. practice:"aem").',
        {
            project: z.string().optional().describe('Filter by project'),
            status: z.enum(['experimental', 'approved', 'pending', 'active']).optional().describe('Filter by approval status'),
            practice: z.string().optional().describe('Filter by practice / capability group (aem, aep, braze, campaign - see list_practices)')
        },
        async ({ project, status, practice }) => {
            const entries = await store.listResources({ project, status, practice, visibleTo: resolvePrincipal(context), visibleSubmitted: callerCanReview(context) })
            return jsonResult(entries.filter(e => e.type !== HANDOFF_TYPE))
        }
    )

    server.tool(
        'list_practices',
        'List the configured practices / capability groups (e.g. AEM, AEP, Braze, Adobe Campaign) and which ones YOU belong to. Practices are how knowledge stays findable per discipline: filter list_jobs / search_resources / list_resources by practice to see just that discipline\'s work. Read-only, safe for anyone.',
        {},
        async () => jsonResult({
            practices: settings.practices(),
            my_practices: settings.practicesForOwner(resolvePrincipal(context)),
            my_default_practice: settings.defaultPracticeFor(resolvePrincipal(context)),
            note: 'A new job inherits your first practice unless you pass an explicit practice.'
        })
    )

    server.tool(
        'set_practices',
        'ADMIN ONLY: replace the list of practices / capability groups the company delivers (e.g. add "analytics" or "target"). Full replace - pass the complete list. Practices are data, so adding one is a settings change, not a deploy. Existing jobs keep their practice id even if you relabel it.',
        {
            practices: z.array(z.object({
                id: z.string().min(1).describe('Stable short id, lowercase (e.g. "aem") - never change this once jobs use it'),
                label: z.string().min(1).describe('Human-readable label shown in the UI (e.g. "AEM")')
            })).describe('The complete practice list')
        },
        async ({ practices: next }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may change the practice list.')
            const ids = next.map(p => p.id.trim().toLowerCase())
            const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
            if (dupes.length) return errorResult(`Duplicate practice id(s): ${[...new Set(dupes)].join(', ')}`)
            const clean = next.map(p => ({ id: p.id.trim().toLowerCase(), label: p.label.trim() }))
            const current = await store.getSettingsOverride()
            const stored = await store.saveSettingsOverride({ ...current, practices: clean })
            settings._setCache(stored)
            return jsonResult({ practices: settings.practices() })
        }
    )

    server.tool(
        'set_user_practices',
        'HEAD CHEF or ADMIN: set which practices a consultant belongs to. Their first practice is what their new jobs inherit by default, so this is what makes per-discipline capture automatic. Full replace for that user; pass an empty array to clear.',
        {
            owner: z.string().min(1).describe('The consultant\'s owner identity (email/username, as shown by get_my_roles)'),
            practices: z.array(z.string()).describe('The practice ids this consultant works in, most-primary first (see list_practices)')
        },
        async ({ owner, practices: next }) => {
            if (!callerHasRole(context, 'head-chef') && !callerHasRole(context, 'admin')) {
                return errorResult('Refused: only a Head Chef or admin may assign practices.')
            }
            const valid = settings.practiceIds()
            const unknown = next.filter(p => !valid.includes(p))
            if (unknown.length) return errorResult(`Unknown practice id(s): ${unknown.join(', ')}. Valid: ${valid.join(', ') || '(none configured)'}`)
            const current = await store.getSettingsOverride()
            const map = { ...(current.user_practices || {}) }
            const key = owner.trim()
            if (next.length) map[key] = [...new Set(next)]; else delete map[key]
            const stored = await store.saveSettingsOverride({ ...current, user_practices: map })
            settings._setCache(stored)
            return jsonResult({ owner: key, practices: settings.practicesForOwner(key), user_practices: settings.userPracticesMap() })
        }
    )

    server.tool(
        'list_steps',
        'List every non-discarded Step of a Job, in order, with lightweight asset pointers (no binary payload - use get_job for full asset bytes).',
        {
            job_id: z.string().min(1).describe('The job id')
        },
        async ({ job_id: jobId }) => {
            const resource = await store.getResource(jobId)
            if (!resource) {
                return errorResult(`No job found with id '${jobId}'`)
            }
            if (!callerCanRead(resource, context)) return notVisibleError(jobId)
            const steps = stepsLib.ensureSteps(resource)
                .filter(s => s.status !== 'discarded')
                .sort((a, b) => a.order - b.order)
                .map(s => ({ ...s, asset: s.asset ? { path: s.asset.path, mime_type: s.asset.mime_type, size: s.asset.size } : undefined }))
            return jsonResult(steps)
        }
    )

    server.tool(
        'get_active_job',
        'Resolve the active Job (task thread) for a project - the most recently updated, not-yet-baked job - so a second tool (e.g. a coding agent picking up a handoff) appends its work to the SAME job instead of starting a new one (D47). Returns null-ish if the project has no open job yet.',
        {
            project: z.string().min(1).describe('The project to resolve the active job for')
        },
        async ({ project }) => {
            // D99: YOUR active job. It used to resolve across all owners, so it could return a
            // colleague's open job and then invite the caller to append ingredients to it.
            const entries = await store.listResources({ project, type: 'job', owner: resolvePrincipal(context) })
            const open = entries
                .filter(r => !r.baked && r.status !== 'archived')
                .sort((a, b) => (b.updated_at || b.updated || b.created || '').localeCompare(a.updated_at || a.updated || a.created || ''))
            const active = open[0]
            if (!active) return jsonResult({ project, active_job: null })
            return jsonResult({ project, active_job: { id: active.id, title: active.title, status: active.status, step_count: active.step_count } })
        }
    )

    server.tool(
        'bake_job',
        'Finalize a Job (D47): experimental -> baked. With approve_all=true, first certifies every non-discarded step (records consent), so the job\'s followable cookbook view = its approved steps in order. A baked job stays in the cookbook even as later drafts come and go. Distinct from bake_project (which finalizes the whole engagement). This is about the RECORD of a run, NOT the process approval at 1.5 - it does not make the pipeline advance. A run sitting at awaiting_approval is moved by approve_intake.',
        {
            id: z.string().min(1).describe('The job id to bake'),
            approve_all: z.boolean().optional().describe('Approve all non-discarded steps as part of baking (default false - bake as-is, only already-approved steps are followable)'),
            note: z.string().optional().describe('Optional consent note recorded on the steps approved by approve_all')
        },
        async ({ id, approve_all: approveAll, note }) => {
            const resource = await store.getResource(id)
            if (!resource) {
                return errorResult(`No job found with id '${id}'`)
            }
            if (resource.type === HANDOFF_TYPE) {
                return errorResult(`Resource '${id}' is a handoff-prompt, not a job - use set_task_status`)
            }
            // Baking submits work for review, which shows it to every reviewer. That is the
            // author's decision to make, and nobody else's.
            if (!callerCanWrite(resource, context)) return notWritableError(id)
            const now = new Date().toISOString()
            const principal = resolvePrincipal(context)
            const steps = stepsLib.ensureSteps(resource)
            // D64 baking rule: you cannot bake a job with no approved ingredients. The
            // default path requires the human to have approved >= 1 ingredient in the Work Log
            // first (no auto-approve). approve_all=true is the explicit "approve them as part of
            // baking" path for API callers, and still needs >= 1 non-discarded ingredient to
            // approve - you can't bake an empty job either way.
            const nonDiscarded = steps.filter(s => s.status !== 'discarded')
            const approvedExisting = nonDiscarded.filter(s => statusLib.isApproved(s.status))
            if (!approveAll && approvedExisting.length === 0) {
                return errorResult('Cannot submit this job: none of its steps are approved yet. Approve at least one step first, or pass approve_all=true to approve them as part of submitting.')
            }
            if (approveAll && nonDiscarded.length === 0) {
                return errorResult('Cannot submit this job: it has no steps to approve. Nothing has been captured against it yet.')
            }
            let approvedCount = 0
            if (approveAll) {
                for (const step of steps) {
                    if (step.status === 'discarded' || statusLib.isApproved(step.status)) {
                        if (statusLib.isApproved(step.status)) approvedCount++
                        continue
                    }
                    step.status = statusLib.APPROVED
                    step.approved_by = principal
                    step.approved_at = now
                    if (note) step.approval_note = note
                    step.expires_at = undefined
                    approvedCount++
                }
            } else {
                approvedCount = steps.filter(s => statusLib.isApproved(s.status)).length
            }
            resource.baked = true
            resource.baked_at = now
            resource.baked_by = principal
            projectJob(resource, steps, now) // status -> 'baked' (resource.baked is now true)
            await store.saveResource(resource)
            return jsonResult({ id, baked: true, baked_at: now, baked_by: principal, status: resource.status, approved_steps: approvedCount })
        }
    )

    server.tool(
        'bake_project',
        'Mark a Project "baked" - the consultant\'s signal that it is fully cooked (its Test Kitchen work is done). The project keeps its jobs; this just moves it out of the active working set.',
        {
            project: z.string().min(1).describe('The project name, as passed to start_project')
        },
        async ({ project }) => {
            const updated = await store.setProjectStatus(project, 'baked')
            if (!updated) return errorResult(`No project named '${project}' - start one with start_project first`)
            return jsonResult(updated)
        }
    )

    server.tool(
        'set_project_status',
        'Set a Project\'s lifecycle status directly: active (Test Kitchen) -> baked -> archived.',
        {
            project: z.string().min(1).describe('The project name, as passed to start_project'),
            status: z.enum(['active', 'baked', 'archived']).describe('The new lifecycle status')
        },
        async ({ project, status }) => {
            const updated = await store.setProjectStatus(project, status)
            if (!updated) return errorResult(`No project named '${project}' - start one with start_project first`)
            return jsonResult(updated)
        }
    )

    server.tool(
        'list_projects',
        'List Projects with their lifecycle status (active/baked/archived). Scoped to the caller\'s own project records (D53 isolation); the single service principal on the x-api-key path.',
        {},
        async () => jsonResult(await store.listProjects({ owner: resolvePrincipal(context) }))
    )

    server.tool(
        'purge_expired',
        'Run the retention purge on demand: deletes expired EXPERIMENTAL steps (past the retention window) and any job left with no approved/active steps as a result. Approved content is never touched. Idempotent - safe to call repeatedly (this also runs automatically on a daily schedule).',
        {},
        async () => jsonResult(await retention.purgeExpired())
    )

    server.tool(
        'get_settings',
        'Read the connector\'s editable settings (D48): the retention window (days) plus the current segmentation level labels and kind labels (with any overrides applied), and the editable keys/ids so an admin UI can render a form. Reading is safe for anyone.',
        {},
        async () => {
            const eff = settings.effectiveSettings()
            return jsonResult({
                retention_days: eff.retention_days,
                segmentation_levels: segmentation.getConfig().levels.map(l => ({
                    key: l.key, label: eff.segmentation_labels[l.key] || l.label, default_label: l.label
                })),
                kinds: policy.listResourceTypes().map(t => ({
                    type: t.type, label: eff.kind_labels[t.type] || t.title, default_label: t.title, description: t.description, approval: t.approval
                })),
                head_chefs: eff.head_chefs // D64: the config-driven Head Chef roster (see get_role/set_head_chefs)
            })
        }
    )

    server.tool(
        'update_settings',
        'Update the connector\'s editable settings (D48): retention_days, segmentation label overrides, and/or kind label overrides. Only the fields you pass are changed (partial update); internal keys/ids are never changed, only their labels. GUARDED WRITE - through the dashboard this runs under the shared service key; per-user RBAC is a later increment.',
        {
            retention_days: z.number().int().positive().optional().describe('Days an experimental step lives before the retention purge removes it (must be > 0)'),
            segmentation_labels: z.record(z.string(), z.string()).optional().describe('Level key -> new label (e.g. { "epic": "Workstream" }); keys must be existing segmentation level keys'),
            kind_labels: z.record(z.string(), z.string()).optional().describe('Kind id -> new label (e.g. { "decision": "ADR" }); keys must be existing resource-policy type ids')
        },
        async ({ retention_days: retentionDays, segmentation_labels: segLabels, kind_labels: kindLabels }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may edit settings.')
            const current = await store.getSettingsOverride()
            const next = { ...current }

            if (retentionDays !== undefined) next.retention_days = retentionDays

            if (segLabels) {
                const validKeys = new Set(segmentation.levelKeys())
                const bad = Object.keys(segLabels).filter(k => !validKeys.has(k))
                if (bad.length) return errorResult(`Unknown segmentation level key(s): ${bad.join(', ')} (valid: ${[...validKeys].join(', ')})`)
                next.segmentation_labels = { ...(current.segmentation_labels || {}), ...segLabels }
            }
            if (kindLabels) {
                const validTypes = new Set(POLICY_TYPE_IDS)
                const bad = Object.keys(kindLabels).filter(k => !validTypes.has(k))
                if (bad.length) return errorResult(`Unknown kind id(s): ${bad.join(', ')} (valid: ${[...validTypes].join(', ')})`)
                next.kind_labels = { ...(current.kind_labels || {}), ...kindLabels }
            }

            const stored = await store.saveSettingsOverride(next)
            settings._setCache(stored) // reflect immediately within this request
            return jsonResult(settings.effectiveSettings())
        }
    )

    server.tool(
        'admin_list_jobs',
        'ADMIN (D55, scoped in D98): jobs across all owners that have been SUBMITTED for review or ADMITTED to the Company CX Graph, plus your own work and anything assigned to you. It does NOT show other people\'s private drafts: an admin reviews what people chose to submit, and nobody reads unsubmitted work belonging to someone else. Optional project/status/owner filters.',
        {
            project: z.string().optional().describe('Filter by project'),
            status: z.enum(['experimental', 'approved', 'pending', 'active']).optional().describe('Filter by approval status'),
            owner: z.string().optional().describe('Narrow to one owner (see the owner labels in any listing)')
        },
        async ({ project, status, owner }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: admin cross-owner listing requires the admin role.')
            /*
             * D98: this used to pass no visibility filter at all, so an admin read every private
             * draft in the company. Being able to administer a system is not the same as being
             * entitled to read unfinished work, and a consultant who has not submitted something
             * has not offered it to anyone. The admin view now uses exactly the same four rules as
             * every other read path, with the reviewer allowance that lets a head chef or admin
             * open a SUBMITTED candidate in order to review it.
             */
            const entries = await store.listResources({
                project,
                status,
                owner,
                visibleTo: resolvePrincipal(context),
                visibleSubmitted: true
            })
            return jsonResult(entries.filter(e => e.type !== HANDOFF_TYPE))
        }
    )

    server.tool(
        'admin_list_projects',
        'ADMIN (D55): list Project records across ALL owners (personal list_projects scopes to the caller). Same guard posture as admin_list_jobs.',
        {},
        async () => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: admin cross-owner listing requires the admin role.')
            return jsonResult(await store.listProjects())
        }
    )

    server.tool(
        'admin_reset_data',
        'DESTRUCTIVE ADMIN RESET (D52): delete ALL jobs/ingredients, the catalog index, all project records, the work-context, and stored assets - leaving tools/model/config (incl. the settings override) intact. Requires confirm=true. Not available through the dashboard proxy; x-api-key/admin only.',
        {
            confirm: z.boolean().describe('Must be true - a guard against accidental wipes')
        },
        async ({ confirm }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may reset the data store.')
            if (confirm !== true) {
                return errorResult('Refusing to reset: pass confirm=true to delete all jobs, steps, projects, and the catalog (config is preserved).')
            }
            const result = await store.resetAll()
            return jsonResult({ reset: true, ...result })
        }
    )

    server.tool(
        'get_role',
        'Report the caller\'s role(s) (D64/D66): "chef" (everyone by default), "head-chef" (admits baked jobs into the Company CX Graph), and/or "admin" (manage roles, admin views, settings/reset). Also returns the resolved owner identity, the full roles array, and the head-chef roster. Read-only, safe for anyone. NOTE: roles bind to owner identity - on the shared x-api-key path the owner is a single service account, so real per-user enforcement arrives once an OAuth provider is wired (D66/Phase 2).',
        {},
        async () => {
            const roles = callerRoles(context)
            return jsonResult({
                owner: resolvePrincipal(context),
                role: roles.includes('head-chef') ? 'head-chef' : 'chef', // back-compat scalar (D64)
                roles, // D66 full set
                head_chefs: settings.headChefs(),
                enforcement: 'roles bind to owner identity; per-user identity enforcement is real once an OAuth provider is wired (D66/Phase 2)'
            })
        }
    )

    server.tool(
        'get_my_roles',
        'Report just the caller\'s resolved owner identity and role set (D66) - a lightweight self-check for the dashboard. Read-only, safe for anyone.',
        {},
        async () => jsonResult({ owner: resolvePrincipal(context), roles: callerRoles(context) })
    )

    server.tool(
        'list_user_roles',
        'ADMIN ONLY (D66): list the stored user->roles assignments (owner identity -> roles[]), plus the effective roster derived views (head-chefs, bootstrap admins). Guarded: only an admin caller may list. Read-only.',
        {},
        async () => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may view role assignments.')
            return jsonResult({
                user_roles: settings.userRolesMap(),
                head_chefs: settings.headChefs(),
                bootstrap_admins: settings.getBootstrapAdmins(),
                valid_roles: settings.VALID_ROLES
            })
        }
    )

    server.tool(
        'set_user_roles',
        'ADMIN ONLY (D66): set the complete role set for one owner identity (multi-role allowed: any of chef/head-chef/admin). Full replace for that owner. Persisted as a settings override. Guarded: only an admin caller may assign roles. Passing an empty array resets the owner to the default (chef).',
        {
            owner: z.string().min(1).describe('The owner identity (email/username/sub, or "service-account") to assign roles to'),
            roles: z.array(z.enum(['chef', 'head-chef', 'admin'])).describe('The complete role set for this owner (multi-role). Empty = reset to default chef.')
        },
        async ({ owner, roles }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may assign roles.')
            const clean = [...new Set(roles.filter(r => settings.VALID_ROLES.includes(r)))]
            const current = await store.getSettingsOverride()
            const map = { ...(current.user_roles || {}) }
            if (clean.length) map[owner.trim()] = clean; else delete map[owner.trim()]
            const stored = await store.saveSettingsOverride({ ...current, user_roles: map })
            settings._setCache(stored)
            return jsonResult({ owner: owner.trim(), roles: settings.rolesFor(owner.trim()), user_roles: settings.userRolesMap() })
        }
    )

    // ── User accounts (D81) ──────────────────────────────────────────────────────────────────
    // An admin creates a login id + password per consultant, and that login identifies them in
    // both the dashboard and their AI client. Replaces the shared deployment passcode, which
    // proved only that someone was allowed in, never who they were. Passwords are scrypt-hashed
    // by lib/auth/users.js and never stored, returned or logged in plaintext.

    server.tool(
        'create_user',
        'ADMIN ONLY (D81): create a Cookbook login for a consultant - a login id and password they use to sign in to the dashboard and to connect their AI client. Optionally assigns roles and practices at the same time, so a new joiner is productive immediately. The password is hashed on write and is NEVER retrievable afterwards: capture it at creation time and hand it over securely.',
        {
            id: z.string().min(2).describe('Login id, e.g. "jesse.pinkman" (case-insensitive; letters, numbers, dot, dash, underscore)'),
            password: z.string().min(8).describe('Initial password (minimum 8 characters). Stored only as a scrypt hash.'),
            email: z.string().optional().describe('Work email - becomes the owner identity that authors their jobs, and matches them to the same person if SSO is enabled later. Strongly recommended.'),
            display_name: z.string().optional().describe('Human-readable name, e.g. "Jesse Pinkman"'),
            roles: z.array(z.enum(['chef', 'head-chef', 'admin', 'viewer'])).optional().describe('Roles to grant. Omit for a normal consultant (chef). "viewer" is exclusive and read-only.'),
            practices: z.array(z.string()).optional().describe('Practice/capability group ids this consultant works in (call list_practices). Their jobs inherit the first one.')
        },
        async ({ id, password, email, display_name: displayName, roles, practices }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may create Cookbook logins.')

            const practiceIds = settings.practiceIds()
            for (const p of (practices || [])) {
                if (!practiceIds.includes(p)) {
                    return errorResult(`Unknown practice id '${p}'. Configured practices: ${practiceIds.join(', ') || '(none)'}. Add it with set_practices first.`)
                }
            }

            const users = await store.listUsers()
            const wanted = usersLib.normalizeId(id)
            if (users.some(u => usersLib.normalizeId(u.id) === wanted)) {
                return errorResult(`A login with id '${wanted}' already exists. Use set_user_password to reset it, or pick a different id.`)
            }

            const built = usersLib.buildUser({ id, password, email, display_name: displayName, roles, practices, created_by: resolvePrincipal(context) })
            if (!built.ok) return errorResult(built.error)

            await store.saveUsers([...users, built.user])

            // Roles and practices live in settings (authoritative and separately editable), so the
            // account creation and the authorisation it implies stay consistent.
            const current = await store.getSettingsOverride()
            const next = { ...current }
            if (roles && roles.length) {
                const clean = [...new Set(roles.filter(r => settings.VALID_ROLES.includes(r)))]
                next.user_roles = { ...(current.user_roles || {}), [built.user.owner]: clean }
            }
            if (practices && practices.length) {
                next.user_practices = { ...(current.user_practices || {}), [built.user.owner]: [...new Set(practices)] }
            }
            if (next.user_roles || next.user_practices) {
                const stored = await store.saveSettingsOverride(next)
                settings._setCache(stored)
            }

            return jsonResult({
                created: usersLib.publicUser(built.user),
                roles: settings.rolesFor(built.user.owner, built.user.roles),
                practices: settings.practicesForOwner(built.user.owner),
                // Everything the new user needs to connect, so the caller can hand over one bundle.
                connection: {
                    login_id: built.user.id,
                    dashboard: 'Sign in at the Cookbook dashboard with this login id and password.',
                    mcp_header: `x-cookbook-login: ${built.user.id}:<password>`,
                    note: 'The password is not stored in retrievable form. If it is lost, an admin resets it with set_user_password.'
                }
            })
        }
    )

    server.tool(
        'list_users',
        'ADMIN ONLY (D81): list Cookbook logins with their roles, practices and who created them. Never returns password material of any kind.',
        {},
        async () => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may list Cookbook logins.')
            const users = await store.listUsers()
            return jsonResult(users.map(u => ({
                ...usersLib.publicUser(u),
                effective_roles: settings.rolesFor(u.owner || u.id, u.roles),
                effective_practices: settings.practicesForOwner(u.owner || u.id)
            })))
        }
    )

    server.tool(
        'list_people',
        'The company name directory (D96): each person\'s owner identity and their display name. Readable by anyone signed in, and deliberately narrow: no password material, no roles, no account state. Use it to show people by name instead of guessing a name from their email address, and to offer a valid list when assigning work.',
        {},
        async () => {
            const users = await store.listUsers()
            return jsonResult(users
                .filter(u => !u.disabled)
                .map(u => ({
                    id: u.id,
                    owner: u.owner || u.id,
                    // Fall back to the login id rather than inventing a name from the email.
                    display_name: u.display_name || u.id
                }))
                .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name))))
        }
    )

    server.tool(
        'set_user_display_name',
        'ADMIN ONLY (D96): correct how a person\'s name is shown. Names get typed in a hurry when a login is created, and a wrong one then follows that person across every job they author, so it needs to be fixable without recreating the account.',
        {
            id: z.string().min(2).describe('The login id whose name to change'),
            display_name: z.string().min(1).describe('How this person should be shown, e.g. "Dirk"')
        },
        async ({ id, display_name: displayName }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may change how someone is shown.')
            const users = await store.listUsers()
            const wanted = usersLib.normalizeId(id)
            const idx = users.findIndex(u => usersLib.normalizeId(u.id) === wanted)
            if (idx < 0) return errorResult(`No login found with id '${wanted}'. List them with list_users.`)

            const clean = String(displayName).trim()
            if (!clean) return errorResult('A display name cannot be blank.')
            const before = users[idx].display_name || users[idx].id
            users[idx] = { ...users[idx], display_name: clean }
            await store.saveUsers(users)
            return jsonResult({ id: wanted, display_name: clean, was: before })
        }
    )

    server.tool(
        'set_user_password',
        'ADMIN ONLY (D81): reset a Cookbook login\'s password. Used when a password is forgotten - the old one is not recoverable by anyone, including admins, by design.',
        {
            id: z.string().min(2).describe('The login id to reset'),
            password: z.string().min(8).describe('The new password (minimum 8 characters)')
        },
        async ({ id, password }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may reset a password.')
            const users = await store.listUsers()
            const wanted = usersLib.normalizeId(id)
            const idx = users.findIndex(u => usersLib.normalizeId(u.id) === wanted)
            if (idx < 0) return errorResult(`No login found with id '${wanted}'. List them with list_users.`)

            const strength = usersLib.checkPasswordStrength(password)
            if (!strength.ok) return errorResult(strength.error)

            const { salt, hash, algo } = usersLib.hashPassword(password)
            users[idx] = { ...users[idx], salt, hash, algo, password_updated_at: new Date().toISOString() }
            await store.saveUsers(users)
            return jsonResult({ id: wanted, password_updated_at: users[idx].password_updated_at, note: 'Hand the new password over securely. It cannot be read back.' })
        }
    )

    // ── Assignment (D86) ─────────────────────────────────────────────────────────────────────
    // The only way unfinished work crosses between consultants. Everything else is either yours,
    // admitted to the CX graph by a Head Chef, or (for reviewers) submitted for review.

    /**
     * Resolve a person to the canonical owner identity used everywhere else, accepting either a
     * login id or an email. Typos are rejected rather than stored: an assignment to
     * "jesse.pinkmn" would silently grant nobody access, and the assigner would believe it worked.
     * @param {string} who
     * @returns {Promise<{ok: boolean, owner?: string, error?: string}>}
     */
    async function resolveAssignee (who) {
        const wanted = String(who || '').trim()
        if (!wanted) return { ok: false, error: 'Name someone to assign this to.' }
        const users = await store.listUsers()
        if (!users.length) {
            // No account system in use on this deployment; accept the identity as given.
            return { ok: true, owner: wanted }
        }
        const lower = wanted.toLowerCase()
        const match = users.find(u =>
            usersLib.normalizeId(u.id) === lower ||
            String(u.owner || '').toLowerCase() === lower ||
            String(u.email || '').toLowerCase() === lower)
        if (!match) {
            const known = users.filter(u => !u.disabled).map(u => u.id).join(', ')
            return { ok: false, error: `No Cookbook login matches '${wanted}'. Assign to one of: ${known || '(none)'}.` }
        }
        if (match.disabled) return { ok: false, error: `'${match.id}' is disabled and cannot be assigned work.` }
        return { ok: true, owner: match.owner || match.id }
    }

    server.tool(
        'assign_step',
        'Assign one ingredient to a colleague, which is what makes an UNFINISHED job visible to them (D86). Without an assignment, your drafts are yours alone until a Head Chef admits the job to the Company CX Graph. Use this to hand over a piece of work, ask for a review, or pull someone in. Assign by their login id or email. The job owner, a Head Chef or an admin may assign.',
        {
            step_id: z.string().min(1).describe('The ingredient id, as returned by append_step/list_steps'),
            assignee: z.string().min(1).describe('Who to assign it to: their Cookbook login id or email'),
            note: z.string().optional().describe('Why you are handing this over, e.g. "needs a legal read before we ship"')
        },
        async ({ step_id: stepId, assignee, note }) => {
            const parsed = stepsLib.parseStepId(stepId)
            if (!parsed) return errorResult(`Not a valid ingredient id: '${stepId}'`)
            const resource = await store.getResource(parsed.jobId)
            if (!resource) return errorResult(`No job found for ingredient '${stepId}'`)

            const principal = resolvePrincipal(context)
            const mayAssign = resource.owner === principal || callerHasRole(context, 'head-chef') || callerHasRole(context, 'admin')
            if (!mayAssign) return errorResult('Refused: only the job\'s owner, a Head Chef or an admin may assign its ingredients.')

            const steps = stepsLib.ensureSteps(resource)
            const step = steps.find(s => s.id === stepId)
            if (!step) return errorResult(`No ingredient found with id '${stepId}'`)
            if (step.status === 'discarded') return errorResult('That step was discarded. Assigning it would grant access to something nobody is working on.')

            const who = await resolveAssignee(assignee)
            if (!who.ok) return errorResult(who.error)

            const current = new Set(step.assigned_to || [])
            const already = current.has(who.owner)
            current.add(who.owner)
            step.assigned_to = [...current]
            step.assignment_note = note || step.assignment_note
            step.assigned_by = principal
            step.assigned_at = new Date().toISOString()
            projectJob(resource, steps, new Date().toISOString())
            await store.saveResource(resource)

            return jsonResult({
                step_id: stepId,
                job_id: resource.id,
                assigned_to: step.assigned_to,
                already_assigned: already,
                job_visible_to: resource.assigned_to || [],
                note: `${who.owner} can now see this job in their Work Log, including the parts that are not finished.`
            })
        }
    )

    server.tool(
        'unassign_step',
        'Remove an assignment from an ingredient (D86). If that was the only reason a colleague could see the job, they lose access to it again.',
        {
            step_id: z.string().min(1).describe('The ingredient id'),
            assignee: z.string().min(1).describe('Who to remove: their Cookbook login id or email')
        },
        async ({ step_id: stepId, assignee }) => {
            const parsed = stepsLib.parseStepId(stepId)
            if (!parsed) return errorResult(`Not a valid ingredient id: '${stepId}'`)
            const resource = await store.getResource(parsed.jobId)
            if (!resource) return errorResult(`No job found for ingredient '${stepId}'`)

            const principal = resolvePrincipal(context)
            const mayAssign = resource.owner === principal || callerHasRole(context, 'head-chef') || callerHasRole(context, 'admin')
            if (!mayAssign) return errorResult('Refused: only the job\'s owner, a Head Chef or an admin may change its assignments.')

            const steps = stepsLib.ensureSteps(resource)
            const step = steps.find(s => s.id === stepId)
            if (!step) return errorResult(`No ingredient found with id '${stepId}'`)

            const who = await resolveAssignee(assignee)
            // An unknown assignee is not an error here: removing something that was never there
            // should be a no-op, not a failure.
            const target = who.ok ? who.owner : String(assignee).trim()
            const before = (step.assigned_to || []).length
            step.assigned_to = (step.assigned_to || []).filter(a => a !== target)
            const removed = before !== step.assigned_to.length
            if (!step.assigned_to.length) delete step.assigned_to
            projectJob(resource, steps, new Date().toISOString())
            await store.saveResource(resource)

            const stillVisible = (resource.assigned_to || []).includes(target)
            return jsonResult({
                step_id: stepId,
                removed,
                job_visible_to: resource.assigned_to || [],
                note: removed
                    ? (stillVisible
                        ? `${target} is still assigned to another ingredient of this job, so they keep access.`
                        : `${target} no longer has access to this job, unless it is admitted to the CX graph.`)
                    : `${target} was not assigned to this ingredient. Nothing changed.`
            })
        }
    )

    server.tool(
        'list_my_assignments',
        'Ingredients other people have assigned to you (D86), with who handed them over and why. This is your inbox of work pulled in from colleagues.',
        {},
        async () => {
            const me = resolvePrincipal(context)
            const entries = await store.listResources({ visibleTo: me, visibleSubmitted: callerCanReview(context) })
            const out = []
            for (const entry of entries) {
                if (!(entry.assigned_to || []).includes(me)) continue
                const full = await store.getResource(entry.id)
                for (const s of stepsLib.ensureSteps(full)) {
                    if (s.status === 'discarded' || !(s.assigned_to || []).includes(me)) continue
                    out.push({
                        step_id: s.id,
                        job_id: entry.id,
                        job_title: entry.title,
                        job_owner: entry.owner,
                        kind: s.kind,
                        assigned_by: s.assigned_by || null,
                        assigned_at: s.assigned_at || null,
                        note: s.assignment_note || null
                    })
                }
            }
            out.sort((a, b) => String(b.assigned_at || '').localeCompare(String(a.assigned_at || '')))
            return jsonResult(out)
        }
    )

    server.tool(
        'delete_job',
        'ADMIN ONLY (D84): permanently delete ONE job - for junk, test data, or something captured by mistake. NOT for tidying up agent runs: a run that ended in needs_input or faulted is evidence, and deleting the failed attempts after a retry makes the pipeline look like it worked first time. Runs are refused unless force is true and a human asked. Until now an admin\'s only delete was admin_reset_data, which wipes everything, so removing one bad job meant destroying everyone\'s work. Refuses a job already admitted to the Company CX Graph unless force is true, because other people are relying on it.',
        {
            id: z.string().min(1).describe('The job id to delete'),
            force: z.boolean().optional().describe('Delete even if it is in the Company CX Graph. Requires deliberate intent - other people\'s work may reference it.')
        },
        async ({ id, force }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may delete a job.')
            const resource = await store.getResource(id)
            if (!resource) return errorResult(`No resource found with id '${id}' - nothing to delete.`)
            if (resource.cx_approved === true && force !== true) {
                return errorResult(`Refused: '${id}' is in the Company CX Graph, so other people's work may reference it. Hold it back first with headchef_reject, or pass force: true if you are certain.`)
            }
            /*
             * AN AGENT RUN IS EVIDENCE, NOT CLUTTER.
             *
             * An assistant submitted a brief, got needs_input, rephrased it,
             * got needs_input again, rephrased again, succeeded - and then
             * deleted the two failures so as not to leave "junk runs". The
             * store was left with one clean run, and the truth was three
             * attempts against a parser that false-negatived twice.
             *
             * That is the exact opposite of what this layer is for. B1 says:
             * "Track loop count as a health metric - more than two rounds means
             * the agent FAILED, not the marketer." The failed attempts ARE the
             * metric. Delete them and the agent looks like it worked first time,
             * which is the reported-success-while-failing pattern this whole
             * service exists to expose, produced by our own tidying up.
             *
             * So a run is refused by default. Junk and test data - things
             * captured by hand, by mistake - delete as before.
             */
            if (resource.upstream && force !== true) {
                const ranTo = (resource.agents || []).join(', ') || 'no stages'
                return errorResult(
                    `Refused: '${id}' is an AGENT RUN (${ranTo}), not something captured by hand, so it is ` +
                    'evidence of what the pipeline did and it is not junk. ' +
                    'If it ended in needs_input or faulted, that is the most useful kind of record in here: ' +
                    'B1 measures agent health by how many rounds a brief takes, and deleting the rounds ' +
                    'that failed makes the pipeline look like it worked first time. Three attempts recorded ' +
                    'as one successful run is a false record, and producing those is the failure this ' +
                    'service exists to catch. ' +
                    'If you are cleaning up after retrying a brief: do not. Leave the attempts. ' +
                    'If a specific artifact inside the run is genuinely wrong, discard_step removes that ' +
                    'one and keeps the run. If a human has told you to delete this run, pass force: true.'
                )
            }
            const summary = {
                id,
                title: resource.title,
                owner: resource.owner || null,
                project: resource.project || null,
                step_count: stepsLib.ensureSteps(resource).length,
                was_in_cx_graph: resource.cx_approved === true
            }
            await store.deleteResource(id)

            // D91: say when this leaves an empty project behind. Deleting jobs silently
            // accumulated project records with nothing in them, which then showed up in the
            // dashboard's project filter and selected to an empty screen.
            let projectNowEmpty = false
            if (summary.project) {
                const siblings = await store.listResources({ project: summary.project })
                projectNowEmpty = siblings.length === 0
            }

            return jsonResult({
                deleted: summary,
                deleted_by: resolvePrincipal(context),
                ...(projectNowEmpty ? { project_now_empty: summary.project } : {}),
                note: projectNowEmpty
                    ? `Permanently removed. '${summary.project}' now has no jobs: archive it with set_project_status so it stops appearing as a choice. Rebuild the CX graph if this job was in it.`
                    : 'Permanently removed. Rebuild the CX graph (rebuild_cx_graph) if this job was in it.'
            })
        }
    )

    server.tool(
        'change_my_password',
        'Change YOUR OWN password (D82). Any signed-in user may do this for themselves - it does not require an admin, and an admin cannot see the result. Requires your current password even though you are already signed in.',
        {
            current_password: z.string().min(1).describe('Your current password'),
            new_password: z.string().min(8).describe('The new password (minimum 8 characters)')
        },
        async ({ current_password: currentPassword, new_password: newPassword }) => {
            const principal = resolvePrincipal(context)
            const users = await store.listUsers()
            // Match on the owner identity the caller is authenticated as, so this works whether
            // they signed in by login id or by email.
            const idx = users.findIndex(u => u.owner === principal || usersLib.normalizeId(u.id) === usersLib.normalizeId(principal))
            if (idx < 0) {
                return errorResult('Your identity has no Cookbook login to change. If you are using an api key or a federated sign-in, there is no password for it - ask an admin to create you a login.')
            }

            // Re-check the current password even though the caller is already authenticated. They
            // might hold a different credential type entirely (api key, SSO token), and requiring
            // it means a walked-away session cannot silently lock the real owner out.
            if (!usersLib.verifyPassword(currentPassword, users[idx])) {
                return errorResult('Your current password is incorrect. Nothing was changed.')
            }
            const strength = usersLib.checkPasswordStrength(newPassword)
            if (!strength.ok) return errorResult(strength.error)
            if (usersLib.verifyPassword(newPassword, users[idx])) {
                return errorResult('That is already your current password. Choose a different one.')
            }

            const { salt, hash, algo } = usersLib.hashPassword(newPassword)
            users[idx] = { ...users[idx], salt, hash, algo, password_updated_at: new Date().toISOString() }
            await store.saveUsers(users)
            return jsonResult({
                id: users[idx].id,
                password_updated_at: users[idx].password_updated_at,
                note: 'Password changed. Update it in any AI client config that uses it, and sign in again on other devices.'
            })
        }
    )

    server.tool(
        'set_user_enabled',
        'ADMIN ONLY (D81): disable or re-enable a Cookbook login. Disabling is preferred to deleting when someone leaves - it blocks sign-in while keeping their authored work and its provenance intact.',
        {
            id: z.string().min(2).describe('The login id'),
            enabled: z.boolean().describe('false to block sign-in, true to restore it')
        },
        async ({ id, enabled }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may enable or disable a login.')
            const users = await store.listUsers()
            const wanted = usersLib.normalizeId(id)
            const idx = users.findIndex(u => usersLib.normalizeId(u.id) === wanted)
            if (idx < 0) return errorResult(`No login found with id '${wanted}'.`)

            // Refusing to disable the last admin: locking every admin out of a live deployment is
            // not recoverable through the product, only through redeployment.
            if (!enabled) {
                const stillAdmin = users.filter((u, i) => i !== idx && !u.disabled &&
                    settings.rolesFor(u.owner || u.id, u.roles).includes('admin'))
                const targetIsAdmin = settings.rolesFor(users[idx].owner || users[idx].id, users[idx].roles).includes('admin')
                if (targetIsAdmin && stillAdmin.length === 0) {
                    return errorResult('Refused: this is the last enabled admin login. Create or promote another admin first, or you will lock everyone out.')
                }
            }

            users[idx] = { ...users[idx], disabled: !enabled }
            await store.saveUsers(users)
            return jsonResult(usersLib.publicUser(users[idx]))
        }
    )

    server.tool(
        'set_head_chefs',
        'ADMIN ONLY (D64/D66): replace the Head Chef roster - the list of owner identities allowed to admit jobs into the Company CX Graph. Full replace. Persisted as a settings override. Guarded by the admin role. (set_user_roles is the newer, more general way to grant head-chef; this remains for roster-style edits.)',
        {
            head_chefs: z.array(z.string().min(1)).describe('The complete list of owner identities (email/username/sub, or "service-account" for the shared key) that should hold the head-chef role')
        },
        async ({ head_chefs: heads }) => {
            if (!callerHasRole(context, 'admin')) return errorResult('Refused: only an admin may change the head-chef roster.')
            const current = await store.getSettingsOverride()
            const next = { ...current, head_chefs: [...new Set(heads.map(h => h.trim()).filter(Boolean))] }
            const stored = await store.saveSettingsOverride(next)
            settings._setCache(stored)
            return jsonResult({ head_chefs: settings.headChefs() })
        }
    )

    server.tool(
        'list_cx_pending',
        'The Head Chef review queue (D64): baked jobs that a Head Chef has NOT yet admitted to the Company CX Graph (cx_approved !== true). Cross-owner (a Head Chef reviews everyone\'s candidates). Read-only. A baked job stays here until headchef_approve admits it or headchef_reject holds it back.',
        {
            project: z.string().optional().describe('Filter the queue to one project')
        },
        async ({ project }) => {
            // D99: reviewers only. This lists work other people have submitted but not yet had
            // admitted, and it had no role check at all, so any chef could enumerate the lot.
            if (!callerCanReview(context)) {
                return errorResult('Refused: the Head Chef review queue is for head chefs and admins. Submitted work is visible to reviewers until it is admitted, and then to everyone.')
            }
            const entries = await store.listResources({ project }) // cross-owner review queue
            const pending = entries.filter(e => e.type !== HANDOFF_TYPE && e.baked === true && e.cx_approved !== true)
            return jsonResult(pending)
        }
    )

    server.tool(
        'headchef_approve',
        'HEAD CHEF ONLY (D64): admit a baked job into the Company CX Graph - sets cx_approved. Guarded: only a caller whose owner identity is on the head-chef roster (settings.head_chefs) may call this; anyone else is refused. The job must be baked first (a candidate). This is the second tier of the two-tier flow: chef bakes -> Head Chef admits.',
        {
            job_id: z.string().min(1).describe('The baked job id to admit into the CX graph')
        },
        async ({ job_id: jobId }) => {
            if (!callerHasRole(context, 'head-chef')) {
                return errorResult('Refused: only a Head Chef may admit jobs into the Company CX Graph. Ask an admin to add you to settings.head_chefs (set_head_chefs).')
            }
            const resource = await store.getResource(jobId)
            if (!resource) return errorResult(`No job found with id '${jobId}'`)
            if (resource.type === HANDOFF_TYPE) return errorResult(`Resource '${jobId}' is a handoff-prompt, not a job`)
            if (resource.baked !== true) return errorResult(`Job '${jobId}' is not baked yet - only baked jobs are CX candidates. Bake it first (bake_job).`)
            const now = new Date().toISOString()
            resource.cx_approved = true
            resource.cx_approved_by = resolvePrincipal(context)
            resource.cx_approved_at = now
            await store.saveResource(resource)
            return jsonResult({ id: jobId, cx_approved: true, cx_approved_by: resource.cx_approved_by, cx_approved_at: now })
        }
    )

    server.tool(
        'headchef_reject',
        'HEAD CHEF ONLY (D64): hold a baked job back OUT of the Company CX Graph - clears cx_approved (false). Same head-chef guard as headchef_approve. Use to reverse an earlier admission or to explicitly decline a candidate; the job stays baked and owner-visible, it just does not appear in the cross-owner CX graph.',
        {
            job_id: z.string().min(1).describe('The job id to hold back out of the CX graph')
        },
        async ({ job_id: jobId }) => {
            if (!callerHasRole(context, 'head-chef')) {
                return errorResult('Refused: only a Head Chef may change a job\'s CX-graph admission. Ask an admin to add you to settings.head_chefs (set_head_chefs).')
            }
            const resource = await store.getResource(jobId)
            if (!resource) return errorResult(`No job found with id '${jobId}'`)
            if (resource.type === HANDOFF_TYPE) return errorResult(`Resource '${jobId}' is a handoff-prompt, not a job`)
            // Candidate gate (D79 bugfix): only a BAKED job is a CX candidate, so only a baked
            // job can be held back. headchef_approve always enforced this; reject did not - which
            // let a head-chef stamp cx_approved:false onto another owner's private, un-baked,
            // still-experimental work (a pointless cross-owner write on something that was never a
            // candidate, and a confusing audit trail). Now symmetric with approve.
            if (resource.baked !== true) {
                return errorResult(`Job '${jobId}' is not baked, so it is not a CX candidate - there is nothing to hold back. Only baked jobs reach the Head Chef queue (list_cx_pending).`)
            }
            const now = new Date().toISOString()
            resource.cx_approved = false
            resource.cx_approved_by = resolvePrincipal(context)
            resource.cx_approved_at = now
            await store.saveResource(resource)
            return jsonResult({ id: jobId, cx_approved: false, cx_approved_by: resource.cx_approved_by, cx_approved_at: now })
        }
    )

    /*
     * D106: the Cook-off board, and the ONE deliberate disclosure in the whole system.
     *
     * Crystal colour encodes purity - the share of what you submitted that a Head Chef admitted -
     * and purity needs a denominator. The dashboard used to take it from list_cx_pending, which is
     * reviewers-only, so a plain chef got an empty queue, read it as nothing outstanding, and saw
     * every contributor as a spotless 100%. The same person showed as 50% yellow to a Head Chef and
     * 100% blue to everybody else. A leaderboard that ranks and colours people differently
     * depending on who is looking is not a leaderboard.
     *
     * So the denominator is published here, as COUNTS ONLY: how many jobs each person has
     * submitted, and how many got in. No titles, no ids, no projects, no dates - nothing about WHAT
     * anyone submitted, which stays as private as it was. What this does reveal is that a colleague
     * has n jobs waiting on review, and that is the accepted cost of one honest board.
     */
    server.tool(
        'get_cookoff',
        'The Cook-off board: per-person counts of jobs SUBMITTED for review and ADMITTED to the Company CX Graph, so every viewer computes the same standings and the same purity. Counts only - it carries no titles, ids, projects or dates, and reveals nothing about the content of anyone\'s unadmitted work. Readable by everyone on purpose: a leaderboard that differs by viewer is not a leaderboard.',
        {},
        async () => {
            // Deliberately unscoped: this aggregates across owners by design, and returns nothing
            // that identifies a job. Every other cross-owner read in this file is filtered.
            const entries = await store.listResources({})
            const byOwner = new Map()
            for (const entry of entries) {
                const owner = entry.owner || entry.author
                if (!owner) continue
                if (entry.type === HANDOFF_TYPE) continue
                if (!byOwner.has(owner)) byOwner.set(owner, { owner, submitted: 0, admitted: 0 })
                const row = byOwner.get(owner)
                // Admitting a job never clears baked, so submitted is the superset.
                if (entry.baked === true) row.submitted++
                if (entry.cx_approved === true) row.admitted++
            }
            const board = [...byOwner.values()]
                .filter(r => r.submitted > 0 || r.admitted > 0)
                .map(r => ({
                    ...r,
                    // A job admitted without a recorded bake would otherwise produce >100%.
                    submitted: Math.max(r.submitted, r.admitted),
                    purity: r.submitted || r.admitted
                        ? Math.round((r.admitted / Math.max(r.submitted, r.admitted)) * 1000) / 10
                        : null
                }))
                .sort((a, b) => b.admitted - a.admitted || String(a.owner).localeCompare(String(b.owner)))
            return jsonResult(board)
        }
    )

    server.tool(
        'get_cx_graph',
        'Read the compiled Company CX Knowledge Graph (D40/D53): the cross-owner, APPROVED-ONLY view (nodes = approved jobs + their approved ingredients; edges = composition, lineage, and shared tag/segment/kind). Read-only and safe cross-owner - only consented content is here. Returns the last compile (generated_at) or a not-yet-built marker.',
        {},
        async () => {
            const graph = await store.getCxGraph()
            if (!graph) return jsonResult({ generated_at: null, built: false, node_count: 0, edge_count: 0, nodes: [], edges: [], note: 'Not compiled yet - run rebuild_cx_graph or wait for the daily job.' })
            return jsonResult(graph)
        }
    )

    server.tool(
        'rebuild_cx_graph',
        'Recompile the Company CX Knowledge Graph now from all APPROVED jobs across owners, and cache it. Guarded write (runs under the shared service key today; per-user RBAC later). Also runs daily on a schedule.',
        {},
        async () => {
            const graph = await cxGraph.rebuildAndStore()
            return jsonResult({ rebuilt: true, generated_at: graph.generated_at, job_count: graph.job_count, node_count: graph.node_count, edge_count: graph.edge_count, owners: graph.owners })
        }
    )
}

/**
 * Register captured resources as native MCP Resources (Part B, D26) - so any MCP
 * client (not just the one that saved it) can list/read company knowledge, not
 * just via the custom tools above. Only APPROVED cookbook jobs are exposed:
 * experimental ones aren't consented yet, and handoff-prompts are active task
 * briefs, not reusable cookbook knowledge (D38/D42), so both are excluded. The
 * "active" status filter is alias-aware, so it matches both the new "approved"
 * spelling and legacy "active" records. Backed live by the store/catalog on every
 * request - each request creates a fresh McpServer instance (see index.js).
 * @param {McpServer} server - The MCP server instance
 */
/**
 * @param {object} server
 * @param {{userInfo?: object}} [context] caller identity, needed so resources/read obeys the same
 *   visibility rules as every other read path (D88). index.js has always passed it; the parameter
 *   was simply never declared, so the guard added here referenced an undefined binding.
 */
function registerResources (server, context = {}) {
    const template = new ResourceTemplate('resource://company/{type}/{id}', {
        list: async () => {
            // D99: the same visibility rules as every other read. "approved" alone is not a
            // sharing decision, because approving one ingredient promotes its job, so this
            // surface was listing people's private drafts to any connected client.
            const entries = (await store.listResources({
                status: 'approved',
                visibleTo: resolvePrincipal(context),
                visibleSubmitted: callerCanReview(context)
            })).filter(entry => entry.type !== HANDOFF_TYPE)
            return {
                resources: entries.map(entry => ({
                    uri: `resource://company/${entry.type}/${entry.id}`,
                    name: entry.title,
                    mimeType: policy.mimeTypeForFormat(entry.format)
                }))
            }
        }
    })

    server.resource(
        'company-resource',
        template,
        { description: 'Company knowledge captured via save_resource - decisions, architecture, playbooks, configuration, and more (see get_resource_policy).' },
        async (uri, variables) => {
            const resource = await store.getResource(variables.id)
            // D88: the MCP resources/read path is a read-by-id like any other, so it obeys the same
            // visibility rules. Approved-but-unsubmitted work is private to its owner.
            if (!resource || !statusLib.isApproved(resource.status) || resource.type === HANDOFF_TYPE ||
                !callerCanRead(resource, context)) {
                throw new Error(`Resource ${uri} not found`)
            }
            // The composed how-to (D45): approved steps only, in their original order -
            // a job with unreviewed draft steps alongside its approved ones exposes
            // only the certified subset here.
            const approvedContent = stepsLib.composeContent(stepsLib.ensureSteps(resource), { approvedOnly: true })
            return {
                contents: [
                    {
                        uri: uri.toString(),
                        text: approvedContent,
                        mimeType: policy.mimeTypeForFormat(resource.format)
                    }
                ]
            }
        }
    )
}

/**
 * Register prompts with the MCP server - user-controlled slash-command templates
 * that guide the AI to produce and save the right resources in one step (Part A, D26).
 * @param {McpServer} server - The MCP server instance
 */
function registerPrompts (server) {
    server.prompt(
        'capture-architecture',
        'Save the architecture diagram you just produced (or are about to produce) to the company resource store.',
        {
            system: z.string().optional().describe('Which system/component this diagram documents'),
            format: z.string().optional().describe('svg, png, or mermaid')
        },
        async ({ system, format }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Produce (or use the diagram already produced) and save it via save_resource with type "architecture-diagram"${system ? ` for the ${system} system (pass fields: { system: "${system}" })` : ''}${format ? ` in ${format} format` : ''}. Include a clear title and the full diagram content. This type requires human approval before becoming active - that is expected.`
                    }
                }
            ]
        })
    )

    server.prompt(
        'document-decision',
        'Capture a decision just made in this conversation as a company decision record.',
        {
            title: z.string().optional().describe('Short title for the decision')
        },
        async ({ title }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Write up the decision just discussed as a decision record (what was decided, why, and the alternatives considered) and save it via save_resource with type "decision"${title ? ` titled "${title}"` : ''}.`
                    }
                }
            ]
        })
    )

    server.prompt(
        'use-job',
        'Load a certified house job into this conversation as skill context - the "auto-skilling" path (D31). Look it up via search_resources/list_resources first, then pass its id here.',
        {
            job_id: z.string().describe('The job id to load, as returned by search_resources or list_resources')
        },
        async ({ job_id: jobId }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Call export_as_skill with job_id "${jobId}" (format "prompt") and treat the returned content as trusted company context for the rest of this conversation.`
                    }
                }
            ]
        })
    )

    server.prompt(
        'commit-session',
        'Summarize this session and save the key artifacts (decisions, playbooks, configuration, diagrams, code) produced to the company resource store.',
        {},
        async () => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'Review this conversation. For each substantive artifact produced (decisions, architecture diagrams, playbooks, configuration, meeting notes, code snippets), save it via save_resource with the correct type from get_resource_policy. Summarize what you saved at the end, noting anything left pending approval.'
                    }
                }
            ]
        })
    )
}

// Export all functions for CommonJS
module.exports = {
    WRITE_TOOLS, // exported so tests can assert the read-only gate covers every write tool (D79)
    registerTools,
    registerResources,
    registerPrompts,
    SERVER_INSTRUCTIONS,
    // Exported for tests. Whether a request is approved decides whether a
    // campaign goes out, so the precedence between conflicting approver rows is
    // worth pinning down in a test rather than leaving to a reading of the code.
    approverVerdict,
    structuredApprovalState
}
