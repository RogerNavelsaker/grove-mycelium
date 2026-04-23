# Mycelium

Reactive agent swarm — bottom-up emergent multi-agent execution. No agent understands the whole picture. A shared system decomposes intent into atomic tasks, stateless workers claim and execute them independently, coordination happens through shared state.

## Tech Stack

- **Runtime:** Bun (runs TypeScript directly, no build step)
- **Language:** TypeScript with strict mode (`noUncheckedIndexedAccess`, no `any`)
- **Linting:** Biome (formatter + linter in one tool)
- **Runtime dependencies:** chalk, commander (plus Bun built-in APIs: `bun:sqlite`, `Bun.spawn`, `Bun.file`, `Bun.write`)
- **Dev dependencies:** `@types/bun`, `typescript`, `@biomejs/biome`
- **Storage:** SQLite (task pool via `bun:sqlite`, WAL mode)
- **Config:** YAML (minimal built-in parser)

## Build & Test Commands

```bash
bun test                      # Run all tests
bun test src/pool.test.ts     # Run single test file
bun run lint                  # bunx biome check .
bun run typecheck             # tsc --noEmit
```

## Quality Gates

Run all three before committing:

```bash
bun test && bun run lint && bun run typecheck
```

## Architecture

```
Intent → Decomposer → Task Pool (SQLite) → Workers (tmux) → State Surface (repo)
                ↑                                                    │
                └──────────── state changes trigger re-decomposition ┘
```

### Five Components

1. **Intent** — The human-level goal. Creates a Seeds issue for tracking.
2. **Decomposer** — Claude Code instance that recursively breaks intent into atomic tasks.
3. **Task Pool** — SQLite database. Workers claim tasks atomically. TTL-based retry.
4. **Workers** — Persistent tmux sessions (Claude Code or Sapling). Stateless, loop claiming tasks.
5. **State Surface** — The git repo. Workers operate in isolated worktrees, merge back.

### Key Design Principles

- **No agent-to-agent communication.** Workers never talk to each other.
- **No orchestrator during execution.** Decomposer sets up work, then exits.
- **Stateless workers.** Spin up 3 or 30, doesn't matter.
- **Failure is boring.** Worker dies? TTL expires, another worker picks up the task.
- **Backpressure is structural.** Missing dependencies? Tasks stay pending.

## Directory Structure

```
mycelium/
  src/
    index.ts          # CLI entry + command router + VERSION constant
    types.ts          # All shared types (Task, Intent, Config)
    pool.ts           # SQLite task pool (claim, complete, expire)
    config.ts         # YAML config load/save
    output.ts         # Branded output helpers (chalk)
    merge.ts          # MergeQueue engine with AI conflict resolution
    worker.ts         # Worker task loop (claim → execute → report)
    worktree.ts       # Git worktree management for workers
    tmux.ts           # Tmux session management
    commands/
      init.ts         # mc init — scaffold .mycelium/
      decompose.ts    # mc decompose — recursive task decomposition
      spawn.ts        # mc spawn — spin up tmux workers
      status.ts       # mc status — pool overview
      watch.ts        # mc watch — state surface monitor + re-decomposition
      stop.ts         # mc stop — terminate workers
      tasks.ts        # mc tasks — list tasks
      show.ts         # mc show — detailed task/intent view
      retry.ts        # mc retry — reset failed task
      pool.ts         # mc pool reset — clear pool
      logs.ts         # mc logs — worker execution logs
      doctor.ts       # mc doctor — health checks
      prime.ts        # mc prime — inject session context
      sync.ts         # mc sync — stage/commit .mycelium/
      upgrade.ts      # mc upgrade — upgrade from npm
      completions.ts  # mc completions — shell completions
  scripts/
    version-bump.ts   # Bump version in package.json + src/index.ts
```

## On-Disk Format (.mycelium/)

```
.mycelium/
  config.yaml         # Project config (tracked)
  config.local.yaml   # Machine overrides (gitignored)
  .gitignore          # Ignores runtime state
  tasks.db            # SQLite task pool (gitignored)
  worktrees/          # Git worktrees for workers (gitignored)
  logs/               # Worker execution logs (gitignored)
```

## CLI Command Reference

Binary names: `mycelium`, `mc`

Every command supports `--json` for structured output. Global flags: `-v`, `-q`/`--quiet`, `--verbose`, `--timing`.

### Core Workflow

```
mc init                              Initialize .mycelium/ directory
mc decompose "<intent>"              Recursive decomposition into tasks
  --context <paths>                  Scope to specific files/directories
  --max-depth <n>                    Max recursion (default: 3)
  --dry-run                          Preview without writing
  --re-decompose <id>               Re-decompose existing intent
mc spawn [count]                     Spin up workers (default: 3)
  --runtime <name>                   claude or sapling
  --ttl <seconds>                    Idle timeout (default: 60)
mc watch                             Monitor state, trigger re-decomposition
  --daemon                           Run in background
mc stop [worker-id]                  Terminate worker
  --all                              Stop all workers
```

### Task Management

```
mc status                            Pool overview
  --intent <id>                      Filter by intent
mc tasks                             List tasks
  --status <s>                       Filter: pending, claimed, done, failed
  --intent <id>                      Filter by intent
mc show <id>                         Detailed task or intent view
mc retry <task-id>                   Reset failed task to pending
mc pool reset                        Clear task pool
  --intent <id>                      Only for specific intent
  --force                            Skip confirmation
```

### Infrastructure

```
mc doctor                            Health checks
  --fix                              Auto-fix issues
mc logs                              Worker execution logs
  --worker <id>                      Filter by worker
  --follow                           Follow output
mc prime                             Inject AI agent context
mc sync                              Stage and commit .mycelium/
mc upgrade                           Upgrade from npm
  --check                            Check without installing
mc completions <shell>               Shell completions (bash, zsh, fish)
```

## Task Pool Schema

```sql
CREATE TABLE intents (
  id, seed_id, description, context, status, created_at, satisfied_at
);

CREATE TABLE tasks (
  id, intent_id, status, payload, result, depends_on,
  claimed_by, claimed_at, ttl, retry_count, created_at, completed_at
);
```

## os-eco Integration

- **Seeds:** Intent = 1 Seed issue. Tasks are internal. Seed auto-closes when intent satisfied.
- **Mulch:** Workers run `ml prime` before each task. Record learnings after.
- **Substrate:** Shared infra (worktrees, tmux, runtimes, merge) — extracted from Overstory.
- **Greenhouse:** Can dispatch to Mycelium or Overstory based on issue labels/config.

## Coding Conventions

### Formatting
- **Tab indentation** (enforced by Biome)
- **100 character line width** (enforced by Biome)

### TypeScript
- Strict mode with `noUncheckedIndexedAccess`
- No `any` — use `unknown` and narrow
- All shared types in `src/types.ts`
- Import with `.ts` extensions

### Dependencies
- Minimal runtime deps: only chalk + commander
- Use Bun built-in APIs where possible
- `bun:sqlite` for all database access

### Testing
- Framework: `bun test` (built-in, Jest-compatible)
- Real I/O, no mocks. Use temp directories.
- Colocated tests: `{module}.test.ts`

## Version Management

Version lives in two locations (synced by `scripts/version-bump.ts`):
- `package.json` — `"version"` field
- `src/index.ts` — `export const VERSION = "X.Y.Z"`

Bump via: `bun run version:bump <major|minor|patch>`

## Session Completion Protocol

When ending a work session, complete ALL steps:

1. File issues for remaining work: `sd create --title "..."`
2. Run quality gates: `bun test && bun run lint && bun run typecheck`
3. Close finished issues: `sd close <id>`
4. Push: `sd sync && git push`
5. Verify: `git status` shows "up to date with origin"

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard-v:1 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) for structured expertise management.

**At the start of every session**, run:
```bash
mulch prime
```

This injects project-specific conventions, patterns, decisions, and other learnings into your context.
Use `mulch prime --files src/foo.ts` to load only records relevant to specific files.

**Before completing your task**, review your work for insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made — and record them:
```bash
mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Link evidence when available: `--evidence-commit <sha>`, `--evidence-bead <id>`

Run `mulch status` to check domain health and entry counts.
Run `mulch --help` for full usage.
Mulch write commands use file locking and atomic writes — multiple agents can safely record to the same domain concurrently.

### Before You Finish

1. Discover what to record:
   ```bash
   mulch learn
   ```
2. Store insights from this work session:
   ```bash
   mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
   ```
3. Validate and commit:
   ```bash
   mulch sync
   ```
<!-- mulch:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard-v:1 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- canopy:start -->
## Prompt Management (Canopy)
<!-- canopy-onboard-v:1 -->

This project uses [Canopy](https://github.com/jayminwest/canopy) for git-native prompt management.

**At the start of every session**, run:
```
cn prime
```

This injects prompt workflow context: commands, conventions, and common workflows.

**Quick reference:**
- `cn list` — List all prompts
- `cn render <name>` — View rendered prompt (resolves inheritance)
- `cn emit --all` — Render prompts to files
- `cn update <name>` — Update a prompt (creates new version)
- `cn sync` — Stage and commit .canopy/ changes

**Do not manually edit emitted files.** Use `cn update` to modify prompts, then `cn emit` to regenerate.
<!-- canopy:end -->
