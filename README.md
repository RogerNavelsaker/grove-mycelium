# Mycelium

Reactive agent swarm for bottom-up multi-agent execution.

[![npm](https://img.shields.io/npm/v/@os-eco/mycelium-cli)](https://www.npmjs.com/package/@os-eco/mycelium-cli)
[![CI](https://github.com/jayminwest/mycelium/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/mycelium/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Overstory is top-down: a root agent understands the whole picture, decomposes into branches, branches into leaves. Mycelium is bottom-up: no agent understands the whole picture. A shared system decomposes intent into atomic tasks, stateless workers claim and execute them independently, and coordination emerges from shared state — the Factorio logistics network, not the command center.

## Install

Requires [Bun](https://bun.sh) v1.0+, git, and tmux. At least one supported agent runtime must be installed ([Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Sapling](https://github.com/jayminwest/sapling)).

```bash
bun install -g @os-eco/mycelium-cli
```

Or try without installing:

```bash
npx @os-eco/mycelium-cli --help
```

### Development

```bash
git clone https://github.com/jayminwest/mycelium.git
cd mycelium
bun install
bun link              # Makes 'mycelium' and 'mc' available globally

bun test              # Run all tests
bun run lint          # Biome check
bun run typecheck     # tsc --noEmit
```

## Quick Start

```bash
# Initialize .mycelium/ in your project
cd your-project
mc init

# Decompose an intent into atomic tasks
mc decompose "Refactor all API endpoints to use v2 auth" --context src/routes/

# Preview without writing to the pool
mc decompose "Generate docs for public functions" --dry-run

# Spin up workers to claim and execute tasks
mc spawn 5

# Monitor the pool and trigger re-decomposition on state changes
mc watch

# Check status
mc status

# View task details
mc tasks --status pending
mc show <task-id>

# Retry a failed task
mc retry <task-id>

# Stop all workers
mc stop --all
```

## How It Works

```
Intent → Decomposer → Task Pool → Workers → State Surface
                ↑                                    |
                └────────── state changes trigger ───┘
                            re-decomposition
```

This is not a DAG that runs to completion. It's a reactive loop:

1. **Decompose** — A Claude Code instance breaks human intent into atomic, independent tasks and writes them to a SQLite task pool
2. **Claim** — Stateless workers atomically claim tasks from the pool (with soft dependency resolution)
3. **Execute** — Each worker creates a git worktree, loads expertise via mulch, runs the task, writes results back
4. **Merge** — Completed work merges back to the canonical branch via a merge queue
5. **React** — State changes from completed work feed back to the decomposer, which can create new tasks based on what emerged

Workers never talk to each other. Coordination happens entirely through the shared task pool and state surface.

## Commands

Every command supports `--json` for structured output. Global flags: `-v`/`--version`, `-q`/`--quiet`, `--verbose`, `--timing`. ANSI colors respect `NO_COLOR`.

### Core Workflow

| Command | Description |
|---------|-------------|
| `mc init` | Initialize `.mycelium/` directory with config and task pool |
| `mc decompose "<intent>"` | Recursive decomposition into atomic tasks (`--context`, `--max-depth`, `--dry-run`, `--re-decompose`) |
| `mc spawn [count]` | Spin up tmux workers (default: 3) (`--runtime`, `--ttl`, `--poll-interval`) |
| `mc watch` | Monitor state surface, trigger re-decomposition, expire TTLs (`--daemon`, `--poll-interval`) |
| `mc stop [worker-id]` | Terminate a worker (`--all` for all workers) |

### Task Management

| Command | Description |
|---------|-------------|
| `mc status` | Pool overview: pending, claimed, done, failed counts (`--intent`) |
| `mc tasks` | List tasks with filtering (`--status`, `--intent`) |
| `mc show <id>` | Detailed task or intent view |
| `mc retry <task-id>` | Reset a failed task to pending |
| `mc pool reset` | Clear task pool (`--intent`, `--force`) |

### Infrastructure

| Command | Description |
|---------|-------------|
| `mc doctor` | Health checks: pool integrity, orphaned worktrees, zombie workers (`--fix`) |
| `mc logs` | Worker execution logs (`--worker`, `--follow`) |
| `mc prime` | Inject session context for AI agents |
| `mc sync` | Stage and commit `.mycelium/` changes |
| `mc upgrade` | Upgrade to latest npm version (`--check`) |
| `mc completions <shell>` | Shell completions (bash, zsh, fish) |

## Architecture

Mycelium uses five components: an intent layer, a recursive decomposer, a SQLite task pool with atomic claims, persistent tmux workers, and the git repo as a shared state surface. Workers are stateless and interchangeable — spin up 3 or 30. If a worker dies, its task's TTL expires and another worker picks it up. See [CLAUDE.md](CLAUDE.md) for full technical details.

### Five Components

| Component | Role |
|-----------|------|
| **Intent** | Human-level goal. Creates a Seeds issue for tracking. |
| **Decomposer** | Claude Code instance that recursively breaks intent into atomic tasks. |
| **Task Pool** | SQLite database. Workers claim tasks atomically. TTL-based retry. |
| **Workers** | Persistent tmux sessions (Claude Code or Sapling). Stateless, loop claiming tasks. |
| **State Surface** | The git repo. Workers operate in isolated worktrees, merge back. |

## Project Structure

```
mycelium/
  src/
    index.ts          CLI entry point + VERSION constant
    types.ts          All shared types (Task, Intent, Config)
    pool.ts           SQLite task pool (claim, complete, expire)
    config.ts         YAML config load/save
    output.ts         Branded output helpers (chalk)
    merge.ts          MergeQueue engine with AI conflict resolution
    worker.ts         Worker task loop (claim -> execute -> report)
    worktree.ts       Git worktree management for workers
    tmux.ts           Tmux session management
    commands/
      init.ts         mc init
      decompose.ts    mc decompose
      spawn.ts        mc spawn
      status.ts       mc status
      watch.ts        mc watch
      stop.ts         mc stop
      tasks.ts        mc tasks
      show.ts         mc show
      retry.ts        mc retry
      pool.ts         mc pool reset
      logs.ts         mc logs
      doctor.ts       mc doctor
      prime.ts        mc prime
      sync.ts         mc sync
      upgrade.ts      mc upgrade
      completions.ts  mc completions
  scripts/
    version-bump.ts   Bump version in package.json + src/index.ts
```

## What's in `.mycelium/`

```
.mycelium/
  config.yaml         Project config (tracked)
  config.local.yaml   Machine overrides (gitignored)
  .gitignore          Ignores runtime state
  tasks.db            SQLite task pool (gitignored)
  worktrees/          Git worktrees for workers (gitignored)
  logs/               Worker execution logs (gitignored)
```

## Design Principles

- **No agent-to-agent communication.** Workers never talk to each other. Coordination is structural.
- **No orchestrator during execution.** The decomposer sets up work, then exits. Workers self-organize.
- **Stateless workers.** No memory between tasks. Interchangeable and disposable.
- **Failure is boring.** Worker dies? TTL expires, another worker picks it up.
- **Backpressure is structural.** Missing dependencies keep tasks pending automatically.
- **Git-native.** Workers operate in isolated worktrees. Results merge back via a merge queue.
- **SQLite as the shared bus.** Atomic claims, TTL expiry, dependency resolution — all in one database.

## Part of os-eco

Mycelium is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

| Tool | Purpose |
|------|---------|
| [Overstory](https://github.com/jayminwest/overstory) | Multi-agent orchestration (top-down) |
| [Sapling](https://github.com/jayminwest/sapling) | Headless coding agent |
| [Seeds](https://github.com/jayminwest/seeds) | Git-native issue tracking |
| [Mulch](https://github.com/jayminwest/mulch) | Structured expertise management |
| [Canopy](https://github.com/jayminwest/canopy) | Prompt management |
| [Greenhouse](https://github.com/jayminwest/greenhouse) | Autonomous development daemon |

<p align="center">
  <img src="https://raw.githubusercontent.com/jayminwest/os-eco/main/branding/logo.png" alt="os-eco" width="444" />
</p>

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
