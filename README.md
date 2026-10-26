# Philharmonic

A deterministic generator that produces a complete Claude Code multi-agent development workflow suite for any software project. Answer a set of structured questions and get a ready-to-use set of agent definitions, JSON schemas, an orchestrator workflow script, and a slash command — all configured for your project's tools and conventions.

No AI reasoning happens in the generator itself. Same answers → same output, every time.

## What it produces

```
<output-dir>/
├── agents/
│   ├── product-owner.md    — validates tickets → TaskSpec
│   ├── architect.md        — analyses codebase → ImplementationPlan
│   ├── implementer.md      — implements plan, handles review feedback
│   ├── reviewer.md         — verifies AC coverage, coding standards (read-only)
│   ├── devops.md           — creates PR, monitors CI, collects review comments
│   ├── nag.md              — adversarial stress-tester for agent outputs
│   ├── designer.md         — maps design files → DesignSpec (if design tool configured)
│   ├── tester.md           — writes and runs e2e + a11y tests (if e2e framework configured)
│   ├── rte.md              — splits an approved plan into small PRs (if opted in)
│   └── study-guide.md      — surfaces learning moments from plan and diff (if opted in)
├── workflows/
│   └── dev-workflow.js     — orchestrator state machine
├── skills/
│   └── dev-workflow/
│       └── SKILL.md        — /dev-workflow slash command
├── schemas/
│   ├── task-spec.json
│   ├── implementation-plan.json
│   ├── implementation-result.json
│   ├── review-result.json
│   ├── deploy-status.json
│   ├── rte-breakdown.json  — (if the RTE is included)
│   ├── design-spec.json    — (if design tool configured)
│   └── test-result.json    — (if e2e framework configured)
└── workflow-config.json    — your saved answers (for re-runs and --add-agent)
```

Place the output in your project's `.claude/` directory (the directory Claude Code reads agent and workflow files from).

## Prerequisites

- Python 3 (any recent version; no third-party packages required)

## Usage

### Interactive (first run)

```bash
python3 generate-workflow.py
```

Answer the questions. Press Enter to accept the default shown in `[brackets]`. Review the configuration summary and confirm before any files are written.

### Non-interactive (CI or scripted setup)

```bash
python3 generate-workflow.py --config my-config.json
```

The config file is the same JSON the generator saves to `workflow-config.json` after an interactive run. You can also write one by hand — field names match the question identifiers in the source.

### Override output directory

```bash
python3 generate-workflow.py --config my-config.json --output /path/to/.claude
```

### Update an existing workflow

Re-run with your saved config to regenerate all files in place:

```bash
python3 generate-workflow.py --config <output-dir>/workflow-config.json
```

### Add a single agent to an existing workflow

```bash
python3 generate-workflow.py --config <output-dir>/workflow-config.json --add-agent study-guide
```

Reads the existing config, activates the named agent, and regenerates only the affected files. Available agents: `study-guide`, `rte`.

## Workflow behaviour

Two hard constraints are enforced regardless of configuration:

1. **One ticket at a time.** The workflow stops when the PR is created and CI is green. It never auto-advances to the next ticket. A human must explicitly invoke it again.
2. **Never merges.** The DevOps agent creates PRs and monitors CI only. Merging to the target branch is always a human action.

## Splitting a ticket into several PRs (Release Train Engineer)

By default a ticket becomes one branch and one PR, however large the plan is. Include the **Release Train Engineer (RTE)** and the workflow can instead be run with `rte: true` (the `/dev-workflow <ticket> --rte` flag). A run without `rte` is unchanged: the generated script makes exactly the same agent calls as before, which `tests/` checks against recorded output.

With `rte`, after the Architect and the plan approval:

1. The **RTE** reads the plan and breaks it into a handful of PRs of roughly 10 to 20 files each (a guideline you set with `rte_max_files`, not a hard cap). Each PR carries its own tests, leaves the target branch green, and says which other PRs it depends on. The **Nag** stress-tests the breakdown.
2. The workflow **pauses** and shows you the PR list: how many PRs, what each does, its files and dependencies, and which can be built in parallel. You approve it or send feedback.
3. The workflow builds every PR whose dependencies have merged. PRs that don't depend on each other are built **in parallel**, each in its own git worktree. A PR that depends on another waits until you have merged that one. Each PR gets its own Developer → Reviewer → (Tester) → Study Guide ∥ DevOps run and its own branch and PR.
4. After you merge the open PRs, you run the same command again and the next PRs are built from the updated target branch, until every PR has merged.

Progress is kept in two small files next to your tickets (or in `<output>/rte/`): `<ticket>.rte.json` (stage and PR status) and `<ticket>.rte-context.json` (the plan, read by the agents). The workflow detects merged PRs with `gh`, so it needs a GitHub remote; `rte` cannot be combined with `local_only`.

Add the RTE to an existing workflow with `--add-agent rte`.

## Tests

The workflow script is tested against scripted fake agents, so its control flow can be checked without spending tokens:

```bash
node --test tests/
```

`tests/fixtures/single-pr-golden.json` records the agent calls of the single-PR flow. If you change the single-PR flow on purpose, re-record it with `tests/record-golden.mjs` against a workflow generated before your change.

## What you configure

| Area | What you configure |
|------|--------------------|
| Source control | Platform and MCP identifier |
| Ticket system | Platform and MCP identifier (or none) |
| Design tool | Platform and MCP identifier; deep-dive skill; component library paths (or none) |
| Test suite | Unit test command; e2e framework and run command; accessibility tool (or none) |
| Notifications | MCP identifier (or none) |
| System understanding | Skill for generating an architecture map; where the map persists; skill agents use to read it |
| Skills — Product Owner | Ticket context skill (domain, key files, authors) |
| Skills — Architect | Anti-pattern scanner; duplicate method finder; shared service auditor |
| Skills — Reviewer | First-pass review; re-review; anti-pattern check; PR shape analysis |
| Skills — Developer | Consecutive-failure recovery skill |
| Optional agents | Study Guide (surfaces learning moments from plan and diff); Release Train Engineer (splits a plan into small PRs) |
| Orchestrator | Plan approval gate; tester default; retry limits; CI timeout |
| Scripts | Underlying scripts agents can call directly |

## Agent model and effort

| Agent | Model | Effort |
|-------|-------|--------|
| Product Owner | opus | high |
| Designer | opus | high |
| Architect | opus | max |
| Developer | sonnet | high |
| Reviewer | opus | xhigh |
| Nag | opus | medium |
| Tester | sonnet | high |
| DevOps | sonnet | medium |
| Study Guide | opus | high |
| RTE | opus | high |

## Architecture map

The Architect agent supports an optional pre-built architecture map — a persistent multi-resolution model of the codebase that agents read instead of re-discovering structure on every ticket.

Configure via the "System understanding" questions:
- **Map generator skill** — invoked manually by the developer (`/your-skill-name`) to produce the map and write it to a known file
- **Map path** — where the map file lives (e.g. `.claude/arch-map.json`)
- **Map reader skill** — invoked by the Architect as step 0, loads the map filtered to the relevant domain

When configured, the Architect reads the map first, orients itself, then runs its analysis skills. When the map doesn't exist yet, it falls through to direct codebase investigation.

## License

MIT
