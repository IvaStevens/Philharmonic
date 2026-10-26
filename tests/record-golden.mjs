// Records the golden output of the single-PR scenarios from a given generated
// workflow script. Run it against a workflow generated BEFORE a change to the
// single-PR flow, then commit the result:
//   node tests/record-golden.mjs <path/to/dev-workflow.js> > tests/fixtures/single-pr-golden.json
import { runWorkflow } from './harness.mjs'
import { SINGLE_PR_SCENARIOS } from './scenarios.mjs'

const golden = {}
for (const [name, sc] of Object.entries(SINGLE_PR_SCENARIOS)) {
  const r = await runWorkflow(process.argv[2], sc.args, sc.responders ? sc.responders() : {})
  if (r.error) throw r.error
  golden[name] = { calls: r.calls, logs: r.logs, result: r.result }
}
console.log(JSON.stringify(golden, null, 1))
