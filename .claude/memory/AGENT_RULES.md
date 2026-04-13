# AI Agent Collaboration Guide

## Table of Contents
1. [Communication Protocol](#communication-protocol)
2. [Development Standards](#development-standards)
3. [Testing Standards](#testing-standards)
4. [Environment](#environment)
5. [Development Workflow](#development-workflow)
6. [Twelve-Factor Reference](#twelve-factor-reference)
7. [CLAUDE.md Stub](#claudemd-stub)
8. [AI Agent Instructions](#ai-agent-instructions)

---

## Communication Protocol

### Core Rules
- **Clarity First**: Always ask clarifying questions when requirements are ambiguous
- **Fact-Based**: Base all recommendations on verified, current information
- **Simplicity Advocate**: Call out overcomplications and suggest simpler alternatives
- **Safety First**: Never modify critical systems without explicit understanding and approval

### User Profile
- **Technical Level**: Non-coder but technically savvy
- **Learning Style**: Understands concepts, needs executable instructions
- **Expects**: Step-by-step guidance with clear explanations
- **Comfortable with**: Command-line operations and scripts

### Required Safeguards
- Always identify affected files before making changes
- Never modify authentication systems without explicit permission
- Never alter database schema without proper migration files
- Explain what changes will be made and why

---

## Development Standards

### Validate Before You Build

- **POC everything first.** Before committing to a design, build a quick proof-of-concept (~15 min) that validates the core logic. Keep it stupidly simple — manual steps are fine, hardcoded values are fine, no tests needed yet
- **POC scope:** Cover the happy path and 2-3 common edge cases. If those work, the idea is sound
- **Graduation criteria:** POC validates logic and covers most common scenarios → stop, design properly, then build with structure, tests, and error handling. Never ship the POC — rewrite it
- **Build incrementally.** After POC graduates, break the work into small, independent modules. Focus on one at a time. Each piece must work on its own before integrating with the next

### Dependency Hierarchy

Always exhaust the simpler option before reaching for the next:

1. **Vanilla language** — Write it yourself using only language primitives. If it's <50 lines and not security-critical, this is the answer
2. **Standard library** — Use built-in modules (`os`, `json`, `pathlib`, `http`, `fs`, `crypto`). The stdlib is tested, maintained, and has zero supply chain risk
3. **External library** — Only when both vanilla and stdlib are insufficient. Must pass the checklist below

### External Dependency Checklist

Before adding any external dependency, all of these must be true:
- **Necessity:** Can't reasonably implement this with stdlib in <100 lines
- **Maintained:** Active commits in the last 6 months, responsive maintainer
- **Lightweight:** Few transitive dependencies (check the dep tree, not just the top-level)
- **Established:** Widely used, not a single-maintainer hobby project for production-critical code
- **Security-aware:** For security-critical domains (crypto, auth, sanitization, parsing untrusted input), a vetted library is *required* — never roll your own

### Language Selection

- **Use widely-adopted languages only** — Python, JavaScript/TypeScript, Go, Rust. No niche languages unless the domain demands it
- **Pick the lightest language that fits the domain:** shell scripts for automation, Python for data/backend/CLI, TypeScript for web, Go for systems/infra, Rust for performance-critical
- **Minimize the polyglot tax.** Every language in the stack adds CI config, tooling, and onboarding friction. Do not add a new language for one microservice — use what's already in the stack unless there's a compelling reason
- **Vanilla over frameworks.** Express over NestJS, Flask over Django, unless the project genuinely needs the framework's structure. Structure can always be added later; removing a framework is painful

### Build Rules

- **Open-source only.** Always use open-source solutions. No vendor lock-in
- **Lightweight over complex.** If two solutions solve the same problem, use the one with fewer moving parts, fewer dependencies, and less configuration
- **Every line must have a purpose.** No speculative code, no "might need this later", no abstractions for one use case
- **Simple > clever.** Readable code that a junior can follow beats elegant code that requires a PhD to debug
- **Containerize only when necessary.** Start with a virtualenv or bare metal. Docker adds value for deployment parity and isolation — not for running a script

### Red Flags — Stop and Flag These
- Over-engineering simple problems
- Adding external dependencies for trivial operations
- Frameworks where a library or stdlib would suffice
- Vendor-specific implementations when open alternatives exist
- Skipping POC validation for unproven ideas

---

## Testing Standards

### Rules

**Test behavior, not implementation.** A test suite must give you confidence to refactor freely. If changing internal code (without changing behavior) breaks tests, those tests are liabilities, not assets.

**Follow the Testing Trophy** (not the Testing Pyramid):
- Few unit tests — only for pure logic, algorithms, and complex calculations
- Many integration tests — the sweet spot; test real components working together
- Some E2E tests — cover critical user journeys end-to-end
- Static analysis — types and linters catch bugs cheaper than tests

### When to Write Tests

- **After the design stabilizes, not during exploration.** Do not TDD a prototype — you'll write 500 tests for code you delete tomorrow. First make it work (POC), then make it right (refactor + tests), then make it fast
- **Write tests when the code has users.** If a function is called by other modules or exposed to users, it needs tests. Internal helpers that only serve one caller don't need their own test file
- **Write tests for bugs.** Every bug fix must include a regression test that fails before the fix and passes after. This is the highest-value test you can write
- **Write tests before refactoring.** Before changing working code, write characterization tests first to lock in current behavior, then refactor with confidence
- **Do not write tests for glue code.** Code that just wires components together (calls A then B then C) is tested at the integration level, not unit level

### What Makes a Good Test

- **Tests real behavior.** Call the public API, assert on observable output. Do not reach into internals
- **Fails for the right reason.** A good test fails when the feature is broken, not when the implementation changes
- **Reads like a spec.** Someone unfamiliar with the code must understand what the feature does by reading the test
- **Self-contained.** Each test sets up its own state, runs, and cleans up. No ordering dependencies between tests
- **Fast and deterministic.** Flaky tests erode trust. If a test depends on timing, network, or global state, fix that dependency

---

## Environment

- **OS**: Fedora Linux (use `dnf` for packages, `systemctl` for services)
- **Testing**: pytest (Python), Jest/Vitest (JS/TS), Playwright (browser automation)

---

## Development Workflow

### Environments
- **Development**: Local machines
- **Staging**: VPS with isolated database
- **Production**: VPS with containerized setup

### Deployment Strategy

**Simple Projects:** `Local → GitHub → VPS (direct deployment)`

**Complex Projects:** `Local → GitHub → GHCR → VPS (containerized)`

---

## Twelve-Factor Reference

The [Twelve-Factor App](https://12factor.net) methodology for modern, scalable applications:

| # | Factor | Rule |
|---|--------|------|
| 1 | Codebase | One repo per app, multiple deploys from same codebase |
| 2 | Dependencies | Explicitly declare and isolate all dependencies |
| 3 | Config | Store config in environment variables, never in code |
| 4 | Backing Services | Treat databases, caches, queues as attached resources |
| 5 | Build, Release, Run | Strict separation between build, release, and run stages |
| 6 | Processes | Run as stateless processes, persist state externally |
| 7 | Port Binding | Apps are self-contained, export services via port binding |
| 8 | Concurrency | Scale out via the process model, not bigger instances |
| 9 | Disposability | Fast startup, graceful shutdown, idempotent operations |
| 10 | Dev/Prod Parity | Keep dev, staging, and production as similar as possible |
| 11 | Logs | Treat logs as event streams to stdout |
| 12 | Admin Processes | Run admin/maintenance tasks as one-off processes |

---

## AI Agent Instructions

When working with this user:
1. **Always verify** you understand the requirements before proceeding
2. **Provide step-by-step** instructions with clear explanations
3. **Include ready-to-run** scripts and commands
4. **Explain the "why"** behind technical recommendations
5. **Flag potential issues** before they become problems
6. **Suggest simpler alternatives** when appropriate
7. **Never modify** authentication or database schema without explicit permission
8. **Always identify** which files will be affected by changes
