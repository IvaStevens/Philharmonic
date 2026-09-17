#!/usr/bin/env python3
"""
dev-workflow generator
Reads a config (interactively or from --config <path>) and generates a
complete Claude Code agent + workflow suite from the templates in this repo.

Usage:
    python3 generate-workflow.py
    python3 generate-workflow.py --config my-config.json
    python3 generate-workflow.py --config my-config.json --output /path/to/output
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

TEMPLATES_DIR = Path(__file__).parent / "templates"


# ---------------------------------------------------------------------------
# Template engine
# ---------------------------------------------------------------------------

def _is_truthy(val: str) -> bool:
    return bool(val) and val.strip().lower() not in ("none", "no", "n", "false", "")


def render(template: str, variables: dict) -> str:
    """
    1. Process {{#IF VAR}}...{{/IF}} blocks (iterated until stable — handles nesting).
    2. Replace {{VAR}} placeholders.
    3. Collapse triple+ blank lines to double.
    """
    def replace_if(m):
        var_name = m.group(1)
        content = m.group(2)
        return content if _is_truthy(variables.get(var_name, "")) else ""

    # Iterate until no more conditional blocks remain (handles nesting)
    result = template
    for _ in range(10):
        new_result = re.sub(
            r"\{\{#IF ([A-Z0-9_]+)\}\}(.*?)\{\{/IF\}\}",
            replace_if,
            result,
            flags=re.DOTALL,
        )
        if new_result == result:
            break
        result = new_result

    # Strip any stray {{/IF}} tags left by nested-block edge cases
    result = re.sub(r"\{\{/IF\}\}\n?", "", result)

    # Replace {{VAR}} placeholders
    def replace_var(m):
        return variables.get(m.group(1), "")

    result = re.sub(r"\{\{([A-Z0-9_]+)\}\}", replace_var, result)

    # Collapse 3+ consecutive blank lines to 2
    result = re.sub(r"\n{3,}", "\n\n", result)

    return result


# ---------------------------------------------------------------------------
# Question helpers
# ---------------------------------------------------------------------------

def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        answer = ""
    return answer if answer else default


def ask_yn(prompt: str, default: str = "y") -> str:
    return ask(prompt, default).lower()


def ask_if(condition: bool, prompt: str, default: str = "") -> str:
    if not condition:
        return ""
    return ask(prompt, default)


# ---------------------------------------------------------------------------
# Interactive question loop
# ---------------------------------------------------------------------------

def collect_config_interactive() -> dict:
    cfg = {}
    print("\n=== Project ===")
    cfg["project_name"] = ask("Project name")
    while not cfg["project_name"]:
        print("  Project name is required.")
        cfg["project_name"] = ask("Project name")

    cfg["pr_target_branch"] = ask("PR target branch", "main")
    cfg["source_control"] = ask("Source control? (github/gitlab/bitbucket)", "github")
    cfg["source_control_mcp"] = ask(
        "  Source control MCP identifier? (e.g. mcp__github__, or blank for none)", ""
    )
    cfg["code_standards_doc"] = ask("Code standards doc path? (blank for none)", "")
    cfg["context_file_path"] = ask("Context file output path? (blank for none)", "")
    cfg["output_dir"] = ask("Output directory for generated files", ".claude")

    print("\n=== Ticket system ===")
    cfg["ticket_system"] = ask("Ticket system? (jira/linear/github-issues/other/none)", "none")
    cfg["ticket_system_mcp"] = ask_if(
        _is_truthy(cfg["ticket_system"]),
        "  Ticket system MCP identifier? (blank for none)",
        "",
    )

    print("\n=== Design tool ===")
    cfg["design_tool"] = ask("Design tool? (figma/sketch/other/none)", "none")
    has_design = _is_truthy(cfg["design_tool"])
    cfg["design_tool_mcp"] = ask_if(has_design, "  Design tool MCP identifier? (blank for none)", "")
    cfg["design_deepdive_skill"] = ask_if(has_design, "  Deep-dive skill for design files? (blank for none)", "")
    cfg["component_library_paths"] = ask_if(
        has_design,
        "  Component library path(s)? (comma-separated, blank for none)",
        "",
    )

    print("\n=== Test suite ===")
    cfg["unit_test_command"] = ask("Unit/integration test command? (blank for none)", "")
    cfg["e2e_framework"] = ask("E2E test framework? (playwright/cypress/other/none)", "none")
    has_e2e = _is_truthy(cfg["e2e_framework"])
    cfg["e2e_run_command"] = ask_if(has_e2e, "  E2E run command", "npx playwright test")
    cfg["a11y_tool"] = ask("Accessibility testing tool? (axe-core/pa11y/other/none)", "none")
    has_a11y = _is_truthy(cfg["a11y_tool"])
    cfg["a11y_run_command"] = ask_if(has_a11y, "  A11y run command? (blank for none)", "")

    print("\n=== Notifications ===")
    cfg["notification_mcp"] = ask("Notification MCP? (slack/teams/other/none)", "none")
    has_notif = _is_truthy(cfg["notification_mcp"])
    cfg["notification_mcp_id"] = ask_if(has_notif, "  Notification MCP identifier? (blank for none)", "")

    print("\n=== Orchestrator ===")
    cfg["plan_approval"] = ask_yn("Always pause for human approval on implementation plan?", "y")
    cfg["tester_default"] = ask_yn("Include Tester stage by default?", "n")
    cfg["max_internal_retries"] = ask("Max internal review retries before halting", "3")
    cfg["max_pr_review_cycles"] = ask("Max PR comment review cycles before halting", "3")
    cfg["ci_timeout_minutes"] = ask("CI timeout (minutes)", "30")

    print("\n=== System understanding ===")
    cfg["arch_map_skill"] = ask(
        "Skill for generating the architecture map? (blank for none)", ""
    )
    has_arch_map = _is_truthy(cfg["arch_map_skill"])
    cfg["arch_map_path"] = ask_if(
        has_arch_map, "  Where does the map persist? (file path, blank for none)", ""
    )
    cfg["arch_map_read_skill"] = ask_if(
        has_arch_map,
        "  Skill agents use to read the map? (blank for none)",
        "",
    )

    print("\n=== Skills — Product Owner ===")
    cfg["po_ticket_context_skill"] = ask(
        "Skill for resolving ticket context (domain, key files, authors)? (blank for none)", ""
    )

    if has_design:
        print("\n=== Skills — Designer ===")
        cfg["designer_deepdive_skill"] = ask("Skill for deep-diving design files? (blank for none)", "")
    else:
        cfg["designer_deepdive_skill"] = ""

    print("\n=== Skills — Architect ===")
    cfg["architect_antipattern_skill"] = ask("Skill for anti-pattern scanning? (blank for none)", "")
    has_ap = _is_truthy(cfg["architect_antipattern_skill"])
    cfg["architect_antipattern_domain_scope"] = ask_if(
        has_ap, "  Supports --domain scoping? (y/n)", "n"
    )
    cfg["architect_duplicate_skill"] = ask("Skill for finding duplicate methods/patterns? (blank for none)", "")
    cfg["architect_shared_audit_skill"] = ask(
        "Skill for auditing high-caller shared services? (blank for none)", ""
    )

    print("\n=== Skills — Reviewer ===")
    cfg["reviewer_first_pass_skill"] = ask("Skill for first review pass (most thorough)? (blank for none)", "")
    cfg["reviewer_reread_skill"] = ask("Skill for re-review after targeted fixes? (blank for none)", "")
    cfg["reviewer_antipattern_skill"] = ask("Skill for anti-pattern check on the diff? (blank for none)", "")
    has_rev_ap = _is_truthy(cfg["reviewer_antipattern_skill"])
    cfg["reviewer_antipattern_domain_scope"] = ask_if(
        has_rev_ap, "  Supports --domain scoping? (y/n)", "n"
    )
    cfg["reviewer_pr_context_skill"] = ask("Skill for PR shape / blast radius analysis? (blank for none)", "")

    print("\n=== Skills — Developer ===")
    cfg["developer_consecutive_failure_skill"] = ask(
        "Skill to use after consecutive review failures? (blank for none)", ""
    )
    has_fail_skill = _is_truthy(cfg["developer_consecutive_failure_skill"])
    cfg["developer_consecutive_failure_threshold"] = ask_if(
        has_fail_skill, "  Trigger after how many consecutive failures", "2"
    )

    print("\n=== Optional agents ===")
    cfg["include_study_guide"] = ask_yn("Include Study Guide agent (surfaces learning moments from plan and diff)?", "n")

    print("\n=== Scripts (optional) ===")
    scripts = []
    want_scripts = ask_yn("Any underlying scripts agents can call directly?", "n")
    if want_scripts == "y":
        while True:
            path = ask("  Script path? (blank to finish)", "")
            if not path:
                break
            purpose = ask("  Purpose?", "")
            agent = ask("  Which agent uses it? (product-owner/designer/architect/developer/reviewer/devops)", "")
            when = ask("  When is it called directly instead of via skill?", "")
            scripts.append({"path": path, "purpose": purpose, "agent": agent, "when": when})
    cfg["scripts"] = scripts

    return cfg


# ---------------------------------------------------------------------------
# Config → variables
# ---------------------------------------------------------------------------

def build_variables(cfg: dict) -> dict:
    scripts = cfg.get("scripts", [])
    if scripts:
        header = "| Script | Purpose | Agent | When called directly |\n|--------|---------|-------|---------------------|\n"
        rows = "\n".join(
            f"| `{s['path']}` | {s['purpose']} | {s['agent']} | {s['when']} |"
            for s in scripts
        )
        scripts_table = header + rows
    else:
        scripts_table = ""

    return {
        "PROJECT_NAME": cfg.get("project_name", ""),
        "PR_TARGET_BRANCH": cfg.get("pr_target_branch", "main"),
        "SOURCE_CONTROL": cfg.get("source_control", "github"),
        "SOURCE_CONTROL_MCP": cfg.get("source_control_mcp", ""),
        "CODE_STANDARDS_DOC": cfg.get("code_standards_doc", ""),
        "CONTEXT_FILE_PATH": cfg.get("context_file_path", ""),
        "TICKET_SYSTEM": cfg.get("ticket_system", ""),
        "TICKET_SYSTEM_MCP": cfg.get("ticket_system_mcp", ""),
        "DESIGN_TOOL": cfg.get("design_tool", ""),
        "DESIGN_TOOL_MCP": cfg.get("design_tool_mcp", ""),
        "DESIGN_DEEPDIVE_SKILL": cfg.get("design_deepdive_skill", ""),
        "COMPONENT_LIBRARY_PATHS": cfg.get("component_library_paths", ""),
        "UNIT_TEST_COMMAND": cfg.get("unit_test_command", ""),
        "E2E_FRAMEWORK": cfg.get("e2e_framework", ""),
        "E2E_RUN_COMMAND": cfg.get("e2e_run_command", ""),
        "A11Y_TOOL": cfg.get("a11y_tool", ""),
        "A11Y_RUN_COMMAND": cfg.get("a11y_run_command", ""),
        "NOTIFICATION_MCP": cfg.get("notification_mcp", ""),
        "NOTIFICATION_MCP_ID": cfg.get("notification_mcp_id", ""),
        "PLAN_APPROVAL": cfg.get("plan_approval", "y"),
        "TESTER_DEFAULT": cfg.get("tester_default", "n"),
        "MAX_INTERNAL_RETRIES": str(cfg.get("max_internal_retries", "3")),
        "MAX_PR_REVIEW_CYCLES": str(cfg.get("max_pr_review_cycles", "3")),
        "CI_TIMEOUT_MINUTES": str(cfg.get("ci_timeout_minutes", "30")),
        "ARCH_MAP_SKILL": cfg.get("arch_map_skill", ""),
        "ARCH_MAP_PATH": cfg.get("arch_map_path", ""),
        "ARCH_MAP_READ_SKILL": cfg.get("arch_map_read_skill", ""),
        "PO_TICKET_CONTEXT_SKILL": cfg.get("po_ticket_context_skill", ""),
        "DESIGNER_DEEPDIVE_SKILL": cfg.get("designer_deepdive_skill", ""),
        "ARCHITECT_ANTIPATTERN_SKILL": cfg.get("architect_antipattern_skill", ""),
        "ARCHITECT_ANTIPATTERN_DOMAIN_SCOPE": cfg.get("architect_antipattern_domain_scope", "n"),
        "ARCHITECT_DUPLICATE_SKILL": cfg.get("architect_duplicate_skill", ""),
        "ARCHITECT_SHARED_AUDIT_SKILL": cfg.get("architect_shared_audit_skill", ""),
        "REVIEWER_FIRST_PASS_SKILL": cfg.get("reviewer_first_pass_skill", ""),
        "REVIEWER_REREAD_SKILL": cfg.get("reviewer_reread_skill", ""),
        "REVIEWER_ANTIPATTERN_SKILL": cfg.get("reviewer_antipattern_skill", ""),
        "REVIEWER_ANTIPATTERN_DOMAIN_SCOPE": cfg.get("reviewer_antipattern_domain_scope", "n"),
        "REVIEWER_PR_CONTEXT_SKILL": cfg.get("reviewer_pr_context_skill", ""),
        "DEVELOPER_CONSECUTIVE_FAILURE_SKILL": cfg.get("developer_consecutive_failure_skill", ""),
        "DEVELOPER_CONSECUTIVE_FAILURE_THRESHOLD": str(cfg.get("developer_consecutive_failure_threshold", "2")),
        "INCLUDE_STUDY_GUIDE": "y" if _is_truthy(cfg.get("include_study_guide", "")) else "",
        "SCRIPTS_TABLE": scripts_table,
    }


# ---------------------------------------------------------------------------
# File generation
# ---------------------------------------------------------------------------

def load_template(relative_path: str) -> str:
    path = TEMPLATES_DIR / relative_path
    if not path.exists():
        raise FileNotFoundError(f"Template not found: {path}")
    return path.read_text(encoding="utf-8")


def write_file(output_path: Path, content: str):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")
    print(f"  wrote {output_path}")


def generate_files(cfg: dict, output_dir: Path):
    variables = build_variables(cfg)
    has_design = _is_truthy(variables["DESIGN_TOOL"])
    has_e2e = _is_truthy(variables["E2E_FRAMEWORK"])

    # Always-present agents
    always_agents = [
        "product-owner",
        "architect",
        "implementer",
        "reviewer",
        "devops",
        "nag",
    ]

    for agent in always_agents:
        tmpl = load_template(f"agents/{agent}.md.tmpl")
        write_file(output_dir / "agents" / f"{agent}.md", render(tmpl, variables))

    # Conditional agents
    if has_design:
        tmpl = load_template("agents/designer.md.tmpl")
        write_file(output_dir / "agents" / "designer.md", render(tmpl, variables))

    if has_e2e:
        tmpl = load_template("agents/tester.md.tmpl")
        write_file(output_dir / "agents" / "tester.md", render(tmpl, variables))

    if _is_truthy(variables.get("INCLUDE_STUDY_GUIDE", "")):
        tmpl = load_template("agents/study-guide.md.tmpl")
        write_file(output_dir / "agents" / "study-guide.md", render(tmpl, variables))

    # Workflow orchestrator
    tmpl = load_template("workflows/dev-workflow.js.tmpl")
    write_file(output_dir / "workflows" / "dev-workflow.js", render(tmpl, variables))

    # Skill
    tmpl = load_template("skills/dev-workflow/SKILL.md.tmpl")
    write_file(output_dir / "skills" / "dev-workflow" / "SKILL.md", render(tmpl, variables))

    # Always-present schemas
    always_schemas = [
        "task-spec",
        "implementation-plan",
        "implementation-result",
        "review-result",
        "deploy-status",
    ]
    for schema in always_schemas:
        tmpl = load_template(f"schemas/{schema}.json.tmpl")
        write_file(output_dir / "schemas" / f"{schema}.json", render(tmpl, variables))

    # Conditional schemas
    if has_design:
        tmpl = load_template("schemas/design-spec.json.tmpl")
        write_file(output_dir / "schemas" / "design-spec.json", render(tmpl, variables))

    if has_e2e:
        tmpl = load_template("schemas/test-result.json.tmpl")
        write_file(output_dir / "schemas" / "test-result.json", render(tmpl, variables))

    # Save config alongside output
    config_path = output_dir / "workflow-config.json"
    config_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    print(f"  wrote {config_path}")


# ---------------------------------------------------------------------------
# --add-agent registry
#
# Each entry is a function that takes the existing cfg dict and returns an
# updated cfg dict. Add new agents here — the function can ask questions,
# set flags, or do both. Keeping handlers here (not in generate_files) means
# the generator never hardcodes agent-specific logic outside this registry.
# ---------------------------------------------------------------------------

def _add_study_guide(cfg: dict) -> dict:
    print("\nAdding: Study Guide agent")
    print("  Surfaces intermediate-to-advanced patterns from plan and diff as teachable concepts.")
    cfg = {**cfg, "include_study_guide": "y"}
    print("  include_study_guide set to y")
    return cfg


ADD_AGENT_HANDLERS: dict = {
    "study-guide": _add_study_guide,
}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Generate a dev workflow suite from templates.")
    parser.add_argument("--config", metavar="PATH", help="Path to a JSON config file (non-interactive mode).")
    parser.add_argument("--output", metavar="PATH", help="Override output directory from config.")
    parser.add_argument(
        "--add-agent",
        metavar="AGENT",
        help=(
            "Add a single agent to an existing generated workflow. "
            f"Requires --config. Available: {', '.join(ADD_AGENT_HANDLERS)}."
        ),
    )
    args = parser.parse_args()

    if args.add_agent and not args.config:
        print(f"Error: --add-agent requires --config (path to an existing workflow-config.json).")
        sys.exit(1)

    if args.add_agent:
        handler = ADD_AGENT_HANDLERS.get(args.add_agent)
        if not handler:
            print(f"Unknown agent '{args.add_agent}'. Available: {', '.join(ADD_AGENT_HANDLERS)}")
            sys.exit(1)
        with open(args.config, encoding="utf-8") as f:
            cfg = json.load(f)
        print(f"Loaded config from {args.config}")
        cfg = handler(cfg)
        output_dir = Path(args.output) if args.output else Path(cfg.get("output_dir", ".claude"))
        print(f"\nRegenerating files to: {output_dir.resolve()}\n")
        generate_files(cfg, output_dir)
        print("\nDone.")
        return

    if args.config:
        with open(args.config, encoding="utf-8") as f:
            cfg = json.load(f)
        print(f"Loaded config from {args.config}")
    else:
        print("Dev Workflow Generator")
        print("======================")
        print("Answer each question (press Enter to accept the default shown in brackets).\n")
        cfg = collect_config_interactive()

        # Summary
        print("\n=== Configuration summary ===")
        for k, v in cfg.items():
            if k == "scripts":
                print(f"  scripts: {len(v)} defined")
            else:
                print(f"  {k}: {v!r}")

        confirm = ask_yn("\nGenerate files with these settings?", "y")
        if confirm != "y":
            print("Aborted.")
            sys.exit(0)

    output_dir = Path(args.output) if args.output else Path(cfg.get("output_dir", ".claude"))
    print(f"\nGenerating files to: {output_dir.resolve()}\n")
    generate_files(cfg, output_dir)
    print("\nDone.")


if __name__ == "__main__":
    main()
