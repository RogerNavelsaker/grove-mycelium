# Changelog

## [Unreleased]

## [0.1.1] — 2026-04-04

Initial release — reactive agent swarm with full decompose → execute → merge cycle.

### Added
- Project scaffolding: CLI entry point (`mc`/`mycelium`), command router, types, config system
- `mc init` — initialize .mycelium/ directory with config, SQLite pool, worktrees, logs
- `mc decompose` — recursive intent decomposition via Claude Code into atomic tasks
  - `--context`, `--max-depth`, `--dry-run`, `--re-decompose` flags
- `mc spawn` — spin up persistent tmux worker sessions
  - `--runtime` (claude/sapling), `--ttl` flags
- `mc watch` — state surface monitor with automatic re-decomposition
  - Auto-close seed issues on intent satisfaction
  - `--daemon` flag for background operation
- `mc stop` — terminate workers (single or `--all`)
- `mc status` — task pool overview with intent/task counts
- `mc tasks` — list tasks with status/intent filtering
- `mc show` — detailed task and intent view
- `mc retry` — reset failed tasks to pending
- `mc pool reset` — clear task pool (with `--intent` and `--force` flags)
- `mc logs` — worker execution log viewer (`--worker`, `--follow`)
- `mc doctor` — health checks with `--fix` auto-repair
- `mc prime` — inject AI agent session context
- `mc sync` — stage and commit .mycelium/ changes
- `mc upgrade` — check/install latest from npm
- `mc completions` — shell completion scripts (bash, zsh, fish)
- SQLite task pool with atomic claiming, soft dependencies, TTL-based expiry
- YAML config system with local overrides
- MergeQueue engine with AI-assisted conflict resolution
- Worker task loop: claim → execute in worktree → report results
- Mulch integration: workers run `ml prime` before tasks, `ml record` after
- Integration tests covering decompose → execute → merge cycle
- Unit tests for pool, config, output, commands, logs, watch, decompose
