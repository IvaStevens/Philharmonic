// Single-PR scenarios shared by the golden recorder and the test. Recording
// them against the workflow as it was before the RTE existed, then asserting
// the new output is identical, is what proves a run without `rte` is unchanged.
export const SINGLE_PR_SCENARIOS = {
  paused_for_plan_approval: { args: { ticket_id: 'T-1' } },
  approved_with_decisions: { args: { ticket_id: 'T-1', plan_approved: true, decisions: 'use X', with_tests: false } },
  review_requests_changes_once: {
    args: { ticket_id: 'T-1', plan_approved: true },
    responders: () => {
      let n = 0
      return { review: () => (n++ === 0 ? { status: 'changes_requested', findings: ['fix'] } : { status: 'approved' }) }
    },
  },
  human_pr_review_cycle: {
    args: { ticket_id: 'T-1', plan_approved: true },
    responders: () => {
      let n = 0
      return {
        devops: () => (n++ === 0
          ? { status: 'changes_requested', pr_url: 'https://pr/1', review_comments: [{ id: 'c1', body: 'rename' }] }
          : { status: 'ready', pr_url: 'https://pr/1' }),
      }
    },
  },
  local_only: { args: { ticket_id: 'T-1', plan_approved: true, local_only: true } },
}
