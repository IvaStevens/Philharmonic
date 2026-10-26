// Tests the generated dev-workflow.js against scripted fake agents.
//   node --test tests/
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWorkflow, unit, breakdown } from './harness.mjs'
import { SINGLE_PR_SCENARIOS } from './scenarios.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const generator = path.join(here, '..', 'generate-workflow.py')
const baseConfig = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'config.json'), 'utf8'))
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'single-pr-golden.json'), 'utf8'))

const CONTROL = '/fixture/tickets/T-1.rte.json'
const CONTEXT = '/fixture/tickets/T-1.rte-context.json'

let plainScript
let rteScript

function generate(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philharmonic-test-'))
  const cfgPath = path.join(dir, 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ ...baseConfig, ...overrides }))
  execFileSync('python3', [generator, '--config', cfgPath, '--output', path.join(dir, 'out')], { stdio: 'ignore' })
  return path.join(dir, 'out', 'workflows', 'dev-workflow.js')
}

before(() => {
  plainScript = generate({ include_rte: 'n' })
  rteScript = generate({ include_rte: 'y' })
})

const agentCalls = (r, type) => r.calls.filter((c) => c.opts.agentType === type)
const labelCalls = (r, prefix) => r.calls.filter((c) => (c.opts.label || '').startsWith(prefix))
const state = (files) => JSON.parse(files.get(CONTROL))

// ── A run without `rte` is unchanged ─────────────────────────────────────────

for (const [name, sc] of Object.entries(SINGLE_PR_SCENARIOS)) {
  for (const [variant, script] of [['without the RTE', () => plainScript], ['with the RTE generated', () => rteScript]]) {
    test(`single-PR flow is unchanged (${name}, ${variant})`, async () => {
      const r = await runWorkflow(script(), sc.args, sc.responders ? sc.responders() : {})
      assert.equal(r.error, undefined)
      assert.deepEqual(r.calls, golden[name].calls)
      assert.deepEqual(r.logs, golden[name].logs)
      assert.deepEqual(r.result, golden[name].result)
    })
  }
}

test('rte: true is rejected when the workflow was generated without the RTE', async () => {
  const r = await runWorkflow(plainScript, { ticket_id: 'T-1', rte: true })
  assert.match(String(r.error?.message), /without the Release Train Engineer/)
})

test('rte: true cannot be combined with local_only', async () => {
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, local_only: true })
  assert.match(String(r.error?.message), /local_only/)
})

// ── RTE: the three stages across invocations ─────────────────────────────────

test('first run plans, saves state, and pauses for plan approval without creating a branch', async () => {
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true })
  assert.equal(r.error, undefined)
  assert.equal(r.result.paused, true)
  assert.equal(r.result.stage, 'plan-approval')
  assert.equal(r.result.rte, true)
  assert.equal(labelCalls(r, 'create-branch').length, 0)
  assert.equal(agentCalls(r, 'rte').length, 0)
  assert.equal(agentCalls(r, 'implementer').length, 0)
  assert.equal(state(r.files).stage, 'plan')
  const ctx = JSON.parse(r.files.get(CONTEXT))
  assert.equal(ctx.task_spec.ticket_id, 'T-1')
  assert.ok(ctx.impl_plan)
})

test('plan_approved runs the RTE (not the PO or architect) and pauses with the PR list', async () => {
  const files = new Map()
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files })
  const b = breakdown([unit('pr1'), unit('pr2', ['pr1'], [1, 2])])
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, plan_approved: true }, { files, rte: [b] })
  assert.equal(r.error, undefined)
  assert.equal(r.result.paused, true)
  assert.equal(r.result.stage, 'breakdown-approval')
  assert.equal(r.result.total_prs, 2)
  assert.deepEqual(r.result.waves, [['pr1'], ['pr2']])
  assert.equal(agentCalls(r, 'product-owner').length, 0)
  assert.equal(agentCalls(r, 'architect').length, 0)
  assert.equal(agentCalls(r, 'implementer').length, 0)
  assert.equal(state(files).stage, 'breakdown')
  assert.match(agentCalls(r, 'rte')[0].prompt, /rte-context\.json/)
  assert.equal(agentCalls(r, 'nag').length, 1)
})

test('without approval, a second invocation just shows the breakdown again', async () => {
  const files = new Map()
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files })
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, plan_approved: true }, { files, rte: [breakdown([unit('pr1', [], [0, 1, 2])])] })
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files })
  assert.equal(r.result.stage, 'breakdown-approval')
  assert.equal(r.calls.filter((c) => c.opts.agentType).length, 0)
})

test('feedback sends the previous breakdown and the feedback back to the RTE', async () => {
  const files = new Map()
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files })
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, plan_approved: true }, { files, rte: [breakdown([unit('pr1', [], [0, 1, 2])])] })
  const r = await runWorkflow(
    rteScript,
    { ticket_id: 'T-1', rte: true, breakdown_feedback: 'split pr1 in two' },
    { files, rte: [breakdown([unit('pr1', [], [0]), unit('pr2', [], [1, 2])])] }
  )
  assert.equal(r.result.total_prs, 2)
  const prompt = agentCalls(r, 'rte')[0].prompt
  assert.match(prompt, /split pr1 in two/)
  assert.match(prompt, /Your previous RteBreakdown/)
})

test('a breakdown with a dependency cycle is sent back, then the run halts if it stays invalid', async () => {
  const files = new Map()
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files })
  const cyc = breakdown([unit('pr1', ['pr2'], [0, 1, 2]), unit('pr2', ['pr1'])])
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, plan_approved: true }, { files, rte: [cyc, cyc, cyc] })
  assert.equal(r.result.halted, true)
  assert.equal(r.result.stage, 'rte')
  assert.match(r.result.problems.join(' '), /cycle/)
  assert.equal(agentCalls(r, 'rte').length, 3)
})

test('a breakdown that leaves an acceptance criterion uncovered is corrected', async () => {
  const files = new Map()
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files })
  const bad = breakdown([unit('pr1', [], [0, 1])])
  const good = breakdown([unit('pr1', [], [0, 1, 2])])
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, plan_approved: true }, { files, rte: [bad, good] })
  assert.equal(r.result.stage, 'breakdown-approval')
  assert.equal(agentCalls(r, 'rte').length, 2)
  assert.match(agentCalls(r, 'rte')[1].prompt, /index 2 is not covered/)
})

// ── RTE: running the units ───────────────────────────────────────────────────

async function approved(units) {
  const files = new Map()
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files })
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, plan_approved: true }, { files, rte: [breakdown(units)] })
  return files
}

const THREE = () => [unit('pr1', [], [0]), unit('pr2', [], [1]), unit('pr3', ['pr1'], [2])]

test('independent PRs run in parallel in their own worktrees; a dependent PR waits', async () => {
  const files = await approved(THREE())
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, breakdown_approved: true }, { files })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.result.ran.map((u) => u.id), ['pr1', 'pr2'])
  assert.deepEqual(r.result.blocked_until_merge, [{ id: 'pr3', title: 'Title pr3', waiting_for: ['pr1'] }])
  const setups = labelCalls(r, 'branch-')
  assert.equal(setups.length, 2)
  for (const s of setups) assert.match(s.prompt, /git worktree add/)
  assert.equal(agentCalls(r, 'implementer').length, 2)
  assert.match(agentCalls(r, 'implementer')[0].prompt, /UNIT SCOPE — this is PR 1 of 3/)
  assert.match(agentCalls(r, 'implementer')[0].prompt, /UNIT WORKTREE/)
  assert.equal(agentCalls(r, 'study-guide').length, 2, 'study guide runs once per PR')
  assert.equal(agentCalls(r, 'devops').length, 2)
  assert.match(agentCalls(r, 'devops')[0].prompt, /\[T-1\] \(1\/3\)/)
  const st = state(files)
  assert.equal(st.stage, 'breakdown-approved')
  assert.deepEqual(st.breakdown.units.map((u) => u.status), ['pr_open', 'pr_open', 'pending'])
})

test('reviewers only see the acceptance criteria belonging to their PR', async () => {
  const files = await approved(THREE())
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, breakdown_approved: true }, { files })
  const review = agentCalls(r, 'reviewer')[0].prompt
  assert.match(review, /UNIT SCOPE — you are reviewing PR 1 of 3/)
  assert.match(review, /task_spec\.acceptance_criteria\): 0\./)
})

test('after PR 1 merges, the dependent PR is built alone in the main checkout', async () => {
  const files = await approved(THREE())
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, breakdown_approved: true }, { files })
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files, prStates: { pr1: 'merged', pr2: 'open' } })
  assert.deepEqual(r.result.ran.map((u) => u.id), ['pr3'])
  assert.equal(labelCalls(r, 'branch-').length, 1)
  assert.doesNotMatch(labelCalls(r, 'branch-')[0].prompt, /git worktree add/)
  assert.match(labelCalls(r, 'branch-')[0].prompt, /git checkout main && git pull/)
  assert.deepEqual(r.result.waiting_on_merge.map((u) => u.id).sort(), ['pr2', 'pr3'])
  assert.equal(r.result.stage, 'breakdown-approved')
})

test('when every PR has merged the ticket is done and nothing is built', async () => {
  const files = await approved([unit('pr1', [], [0, 1, 2])])
  await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, breakdown_approved: true }, { files })
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files, prStates: { pr1: 'merged' } })
  assert.equal(r.result.stage, 'done')
  assert.equal(agentCalls(r, 'implementer').length, 0)
  assert.equal(state(files).stage, 'done')
  const again = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files })
  assert.equal(again.result.stage, 'done')
  assert.equal(again.calls.filter((c) => c.opts.agentType).length, 0)
})

test('sequential: true builds ready PRs one after another without worktrees', async () => {
  const files = await approved(THREE())
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, breakdown_approved: true, sequential: true }, { files })
  assert.deepEqual(r.result.ran.map((u) => u.id), ['pr1', 'pr2'])
  for (const s of labelCalls(r, 'branch-')) assert.doesNotMatch(s.prompt, /git worktree add/)
})

test('a PR whose review never passes halts without stopping its siblings, and is retried next run', async () => {
  const files = await approved([unit('pr1', [], [0, 1]), unit('pr2', [], [2])])
  const r = await runWorkflow(
    rteScript,
    { ticket_id: 'T-1', rte: true, breakdown_approved: true },
    { files, review: (prompt) => (/reviewing PR 1 of 2/.test(prompt) ? { status: 'changes_requested' } : { status: 'approved' }) }
  )
  assert.deepEqual(r.result.halted.map((u) => u.id), ['pr1'])
  assert.deepEqual(r.result.waiting_on_merge.map((u) => u.id), ['pr2'])
  assert.equal(r.result.halted[0].halt.stage, 'review-loop')
  const retry = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true }, { files, prStates: { pr2: 'open' } })
  assert.deepEqual(retry.result.ran.map((u) => u.id), ['pr1'])
  assert.equal(retry.result.halted.length, 0)
})

test('decisions given at approval reach the Developer and the Reviewer of every PR', async () => {
  const files = await approved([unit('pr1', [], [0, 1, 2])])
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, breakdown_approved: true, decisions: 'skip the harness' }, { files })
  assert.match(agentCalls(r, 'implementer')[0].prompt, /skip the harness/)
  assert.match(agentCalls(r, 'reviewer')[0].prompt, /skip the harness/)
  assert.match(state(files).decisions, /skip the harness/)
})

test('restart: true discards saved state and plans again', async () => {
  const files = await approved([unit('pr1', [], [0, 1, 2])])
  const r = await runWorkflow(rteScript, { ticket_id: 'T-1', rte: true, restart: true }, { files })
  assert.equal(r.result.stage, 'plan-approval')
  assert.equal(agentCalls(r, 'product-owner').length, 1)
})
