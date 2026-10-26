// Runs a generated dev-workflow.js against scripted fake agents so the control
// flow can be tested without spending tokens. It fakes agent(), parallel(),
// log() and phase(), and a tiny in-memory file system for the RTE state files.
import fs from 'node:fs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const TASK_SPEC = {
  ticket_id: 'T-1',
  title: 'Add thing',
  project: 'proj',
  branch: 'T-1-add-thing',
  acceptance_criteria: ['first', 'second', 'third'],
  out_of_scope: [],
  linked_docs: [],
  dependencies: [],
  domain: 'd',
  key_files: [],
  authors: [],
  notes: '',
}

const IMPL_PLAN = {
  approach: 'do it',
  files_to_modify: [{ path: 'a.js', reason: 'x' }],
  files_to_create: [{ path: 'b.js', reason: 'y' }],
  patterns_to_follow: [],
  tests_to_update: [],
  risks: [],
  complexity: 'low',
  audit_summary: {},
}

export function unit(id, deps = [], acs = [0], extra = {}) {
  return {
    id,
    title: `Title ${id}`,
    purpose: `Purpose ${id}`,
    branch: `T-1-add-thing-${id}`,
    files: [`${id}-1.js`, `${id}-2.js`],
    file_count: 2,
    depends_on: deps,
    ac_indices: acs,
    size_note: null,
    ...extra,
  }
}

export function breakdown(units) {
  return { summary: `${units.length} PRs`, total_prs: units.length, notes: '', units }
}

// responders: { rte: [..breakdowns in order..], prStates: {id: state}, nag: [..], devops: fn }
export function makeRuntime(responders = {}) {
  const files = responders.files || new Map()
  const calls = []
  const logs = []
  const queues = { rte: [...(responders.rte || [])], nag: [...(responders.nag || [])] }

  async function agent(prompt, opts = {}) {
    calls.push({ prompt, opts: { ...opts } })
    const key = opts.agentType || opts.label || ''
    if (opts.label === 'rte-load') {
      const path = /Read the file (\S+)\./.exec(prompt)[1]
      return files.has(path) ? { exists: true, state: JSON.parse(files.get(path)) } : { exists: false }
    }
    if (opts.label === 'rte-save-state' || opts.label === 'rte-save-context') {
      const path = /write the following JSON to (\S+) exactly/.exec(prompt)[1]
      files.set(path, prompt.slice(prompt.indexOf('\n\n') + 2))
      return { ok: true }
    }
    if (opts.label === 'rte-sync-prs') {
      const ids = [...prompt.matchAll(/^- (\w+): /gm)].map((m) => m[1])
      return { units: ids.map((id) => ({ id, pr_state: (responders.prStates || {})[id] || 'open', pr_url: `https://pr/${id}` })) }
    }
    if (opts.label === 'create-branch' || (opts.label || '').startsWith('branch-')) return { ok: true }
    switch (opts.agentType) {
      case 'product-owner': return responders.taskSpec || TASK_SPEC
      case 'architect': return responders.plan || IMPL_PLAN
      case 'nag': return queues.nag.length ? queues.nag.shift() : { verdict: 'pass', concerns: [] }
      case 'rte': return queues.rte.length ? queues.rte.shift() : null
      case 'implementer': return { status: 'complete', files_changed: ['x.js'], tests_run: [] }
      case 'reviewer': return responders.review ? responders.review(prompt, opts) : { status: 'approved' }
      case 'devops': return responders.devops ? responders.devops(prompt, opts) : { status: 'ready', pr_url: 'https://pr/1' }
      case 'study-guide': return 'guide'
      case 'tester': return { status: 'passed' }
      default: return `unscripted:${key}`
    }
  }

  async function parallel(thunks) {
    return Promise.all(thunks.map(async (t) => { try { return await t() } catch { return null } }))
  }

  return { agent, parallel, calls, logs, files, log: (m) => logs.push(m), phase: () => {} }
}

export async function runWorkflow(scriptPath, args, responders) {
  const src = fs.readFileSync(scriptPath, 'utf8').replace(/^export const meta/m, 'const meta')
  const rt = makeRuntime(responders)
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', src)
  let result, error
  try { result = await fn(rt.agent, rt.parallel, rt.log, rt.phase, args) } catch (e) { error = e }
  return { result, error, calls: rt.calls, logs: rt.logs, files: rt.files }
}
