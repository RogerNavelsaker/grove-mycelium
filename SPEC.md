# Mycelium — Reactive Agent Swarm

> The underground fungal network: no central control, coordinates through shared state, reacts to local conditions. The infrastructure underneath the Overstory.

## One-Liner

Bottom-up emergent multi-agent execution — a shared system decomposes intent into atomic tasks, stateless workers claim and execute them independently, and coordination happens through shared state, not agent communication.

## Core Thesis

Overstory is top-down: a root agent understands the whole picture, decomposes into branches, branches into leaves. Intelligence flows down, results flow up.

Mycelium is bottom-up: no agent understands the whole picture. Intent decomposes into atomic tasks, stateless workers claim them independently, coordination emerges from the shared state. The Factorio logistics network, not the command center.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     MYCELIUM                        │
│                                                     │
│  ┌───────────┐    ┌──────────────────────────────┐  │
│  │ Decomposer│───>│     Task Pool (SQLite)       │  │
│  │ (Claude   │    │                              │  │
│  │  Code)    │<───│  id, status, payload         │  │
│  └───────────┘    │  depends_on, result           │  │
│       ↑           │  claimed_by, ttl              │  │
│       │           └──────┬───┬───┬───────────────┘  │
│  state changes          │   │   │                   │
│  trigger re-            │   │   │                   │
│  decomposition    ┌─────┘   │   └─────┐             │
│       │           ▼         ▼         ▼             │
│  ┌────┴────┐  ┌───────┐ ┌───────┐ ┌───────┐        │
│  │  State  │  │Worker │ │Worker │ │Worker │  ...    │
│  │ Surface │  │ (tmux)│ │ (tmux)│ │ (tmux)│        │
│  │  (repo) │  └───────┘ └───────┘ └───────┘        │
│  └─────────┘                                        │
│                                                     │
│  Seeds: intent-level issue tracking                 │
│  Mulch: expertise/context per task                  │
│  Substrate: shared infra (worktrees, tmux, merge)   │
└─────────────────────────────────────────────────────┘
```

## The Reactive Loop

```
Intent → Decomposer → Task Pool → Workers → State Surface
                ↑                                    │
                └────────── state changes trigger ───┘
                            re-decomposition
```

This is NOT a DAG that runs to completion. It's a loop that reacts. Place a new blueprint in Factorio, the robots just... go. State changes from completed work feed back to the decomposer, which can create new tasks based on what emerged.

## Five Components

### 1. Intent

The human-level ask. A string + optional context.

```bash
mycelium decompose "Refactor all API endpoints to use the new auth middleware"
mycelium decompose "Generate docs for every public function" --context src/
mycelium decompose "Process these 10k records" --context data/input.csv
```

Each intent creates one Seeds issue (`sd create`). The intent ID is the seed ID. All tasks in the pool reference this intent.

### 2. Decomposer

The only "smart" layer. A Claude Code instance that:

1. Receives intent + workspace context
2. Scans relevant files/state to understand scope
3. Produces atomic, independent, idempotent tasks
4. Recursively decomposes tasks that are still too complex
5. Sets soft dependency edges where needed

The decomposer is NOT an orchestrator. It runs upfront, produces tasks, and exits. It runs again only when the watcher detects meaningful state changes.

**Recursive decomposition:**
```
Intent: "Migrate all endpoints to v2 auth"
  → Decomposer scans src/routes/
  → Task: "migrate users.ts" (atomic → write to pool)
  → Task: "migrate posts.ts" (atomic → write to pool)
  → Task: "migrate admin/" (complex → recurse)
    → Task: "migrate admin/roles.ts" (atomic → write to pool)
    → Task: "migrate admin/permissions.ts" (atomic → write to pool)
  → Task: "update integration tests" (depends_on: all above)
```

### 3. Task Pool

SQLite database. The single source of truth for all work.

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  intent_id     TEXT NOT NULL,        -- groups tasks from same intent (= seed ID)
  status        TEXT DEFAULT 'pending', -- pending | claimed | done | failed
  payload       TEXT NOT NULL,        -- what to do (JSON: description, file_scope, context)
  result        TEXT,                 -- what happened (JSON: summary, files_changed, errors)
  depends_on    TEXT,                 -- JSON array of task IDs (soft deps)
  claimed_by    TEXT,                 -- worker ID
  claimed_at    INTEGER,             -- unix timestamp
  ttl           INTEGER DEFAULT 300, -- seconds before unclaimed task returns to pending
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);

CREATE TABLE intents (
  id            TEXT PRIMARY KEY,
  seed_id       TEXT,                -- corresponding seeds issue ID
  description   TEXT NOT NULL,
  context       TEXT,                -- JSON: file paths, additional context
  status        TEXT DEFAULT 'active', -- active | satisfied | failed
  created_at    INTEGER NOT NULL,
  satisfied_at  INTEGER
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_intent ON tasks(intent_id);
CREATE INDEX idx_tasks_claimed ON tasks(claimed_by) WHERE status = 'claimed';
```

**Atomic task claim with soft dependency resolution:**

```sql
UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?
WHERE id = (
  SELECT id FROM tasks
  WHERE status = 'pending'
  AND (depends_on IS NULL OR NOT EXISTS (
    SELECT 1 FROM tasks AS dep
    WHERE dep.id IN (SELECT value FROM json_each(tasks.depends_on))
    AND dep.status != 'done'
  ))
  ORDER BY created_at ASC LIMIT 1
)
RETURNING *;
```

**TTL expiry (run periodically by the watcher):**

```sql
UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL
WHERE status = 'claimed'
AND (strftime('%s', 'now') - claimed_at) > ttl;
```

### 4. Workers

Completely stateless. A worker:

1. Claims a task atomically from the pool
2. Creates a worktree for the task (via @os-eco/substrate)
3. Loads the relevant slice of expertise (`ml prime --files <scope>`)
4. Executes the task (Claude Code or Sapling runtime in tmux)
5. Writes result back to the pool
6. Merges worktree back to state surface (via @os-eco/substrate merge)
7. Cleans up worktree
8. Claims next task

Workers are persistent tmux sessions that loop claiming tasks. When no tasks are available, they poll every 5 seconds. After 60 seconds idle (configurable), they self-terminate.

**Worker identity:**
- `worker-{n}` — sequential numbering on spawn
- No memory between tasks. No knowledge of other workers.
- Interchangeable and disposable. Scale by adding more.

**Runtime support:**
- Claude Code (primary) — full interactive session in tmux
- Sapling (headless) — alternative runtime for simpler tasks

### 5. State Surface

The shared workspace. For Mycelium v1, this is the git repo itself.

- Workers operate in isolated worktrees (one per task)
- Results merge back to the canonical branch via merge queue
- Conflicts resolve at the merge layer (reuse @os-eco/substrate 4-tier merge), not through agent negotiation
- State changes (new commits on canonical branch) trigger re-decomposition via the watcher

## CLI

```
mycelium <command>     CLI name: mycelium
mc <command>           Alias (short form)
```

| Command | Description |
|---------|-------------|
| `mc init` | Scaffold .mycelium/ directory + SQLite task pool + config |
| `mc decompose "<intent>"` | Recursive decomposition → tasks in pool |
| `mc spawn [n]` | Spin up n tmux workers (default: 3) |
| `mc status` | Task pool overview (pending/claimed/done/failed counts) |
| `mc watch` | Monitor state surface, trigger re-decomposition, expire TTLs |
| `mc stop [worker-id\|--all]` | Terminate worker(s) |
| `mc tasks [--status <s>]` | List tasks with filtering |
| `mc show <task-id>` | Detailed task view |
| `mc retry <task-id>` | Reset failed task to pending |
| `mc pool reset [--intent <id>]` | Reset task pool (or just one intent's tasks) |
| `mc logs [--worker <id>]` | View worker execution logs |
| `mc doctor` | Health checks (pool integrity, orphaned worktrees, zombie workers) |
| `mc prime` | Inject session context (like other os-eco tools) |
| `mc sync` | Stage and commit .mycelium/ changes |
| `mc upgrade [--check]` | Upgrade to latest version |

### Command Details

**`mc decompose`**
```bash
mc decompose "Refactor all API endpoints to use v2 auth"
mc decompose "Generate docs for public functions" --context src/lib/
mc decompose "Increase test coverage to 80%" --max-depth 3
mc decompose --re-decompose <intent-id>  # manual re-decomposition trigger
```

Options:
- `--context <paths>` — Scope the decomposer's view to specific files/directories
- `--max-depth <n>` — Maximum recursion depth for decomposition (default: 3)
- `--dry-run` — Show planned tasks without writing to pool
- `--runtime <name>` — Runtime for the decomposer instance (default: claude)

**`mc spawn`**
```bash
mc spawn           # spawn 3 workers (default)
mc spawn 10        # spawn 10 workers
mc spawn --runtime sapling  # use sapling runtime for workers
mc spawn --ttl 600          # workers idle-terminate after 10 min
mc spawn --poll-interval 3  # poll every 3 seconds
```

**`mc watch`**
```bash
mc watch                    # start watcher (foreground)
mc watch --daemon           # start watcher (background)
mc watch --poll-interval 10 # check for state changes every 10s
```

The watcher:
1. Polls for new commits on the canonical branch
2. Expires TTL on claimed tasks (return to pending)
3. Checks if intent is satisfied (all tasks done, acceptance criteria met)
4. Triggers re-decomposition when state changes warrant it
5. Auto-closes the Seeds issue when intent is satisfied

## Configuration

`.mycelium/config.yaml`

```yaml
project:
  name: my-project
  root: .
  canonicalBranch: main

pool:
  database: .mycelium/tasks.db
  defaultTtl: 300        # seconds

decomposer:
  maxDepth: 3             # max recursion levels
  runtime: claude
  model: opus             # smart layer needs the best model

workers:
  defaultCount: 3
  runtime: claude          # or: sapling
  model: sonnet            # workers use cheaper/faster model
  idleTimeout: 60          # seconds before self-termination
  pollInterval: 5          # seconds between task claims
  maxRetries: 2            # times a failed task can be retried

watcher:
  pollInterval: 10         # seconds between state surface checks
  autoRedecompose: true    # trigger re-decomposition on state changes

worktrees:
  baseDir: .mycelium/worktrees

merge:
  aiResolveEnabled: true
  reimagineEnabled: false  # conservative default

mulch:
  enabled: true
  domains: []              # auto-inferred from file scope

seeds:
  enabled: true
  autoClose: true          # close seed when intent is satisfied

runtime:
  default: claude
  capabilities:
    decomposer: claude
    worker: claude          # override per-capability
```

## Task Payload Schema

```typescript
interface TaskPayload {
  description: string;         // Human-readable task description
  fileScope: string[];         // Files this task should touch
  context: string;             // Additional context from decomposer
  acceptanceCriteria: string;  // How to know the task is done
  hints?: string[];            // Optional guidance from decomposer
}

interface TaskResult {
  summary: string;             // What the worker did
  filesChanged: string[];      // Files modified
  commitSha?: string;          // Commit on the worker's branch
  errors?: string[];           // Any issues encountered
  exitCode: number;            // 0 = success
}
```

## os-eco Integration

### Seeds
- `mc decompose "..."` creates a Seed issue for the intent (`sd create --title "..."`)
- Task pool is internal SQLite — finer-grained than Seeds
- `mc watch` closes the Seed when intent is satisfied (`sd close <id>`)
- Workers don't interact with Seeds directly

### Mulch
- Workers run `ml prime --files <scope>` before executing each task
- Workers can record learnings (`ml record`) after significant discoveries
- Decomposer uses `ml prime` for project context during decomposition

### Substrate (@os-eco/substrate)
New shared package extracted from Overstory. Both Overstory and Mycelium depend on it.

```
@os-eco/substrate
  ├── worktree/    # git worktree create, cleanup, list
  ├── tmux/        # session create, send-keys, capture-pane, kill
  ├── runtimes/    # claude, sapling (+ future adapters)
  ├── merge/       # 4-tier conflict resolution
  └── mulch/       # mulch client wrapper
```

This extraction is a prerequisite. Overstory refactors to depend on substrate, then Mycelium depends on substrate.

### Greenhouse
Greenhouse can dispatch to either Overstory or Mycelium based on issue labels or config:

```yaml
# greenhouse config (future)
dispatch:
  default: overstory
  labels:
    parallel: mycelium      # parallelizable work → mycelium
    complex: overstory       # coherent vision needed → overstory
```

Mycelium and Overstory never call each other. They are independent peers.

## Comparison: Overstory vs Mycelium

| Aspect | Overstory | Mycelium |
|--------|-----------|----------|
| **Structure** | Tree (root → branch → leaf) | Flat pool + stateless workers |
| **Coordination** | Top-down delegation | Shared state, self-selection |
| **Agent memory** | Context passed down hierarchy | Stateless, reads from pool per task |
| **Scaling** | Depth (more hierarchy levels) | Width (more workers) |
| **Best for** | Complex tasks needing coherent vision | Parallelizable, independent work units |
| **Failure mode** | Branch failure cascades up | Worker failure is invisible (TTL retry) |
| **Intelligence** | Distributed across hierarchy | Concentrated in decomposer |
| **Communication** | Mail system between agents | None. Ever. |
| **Execution** | Single task per agent session | Workers loop, claiming many tasks |
| **State** | Agent-local context + mail | Shared pool + state surface |

### When to use which

**Use Overstory when:**
- The problem requires a coherent architectural vision across changes
- Tasks have complex interdependencies requiring negotiation
- You need intelligent adaptation during execution (leads adjusting strategy)
- The work is deep, not wide

**Use Mycelium when:**
- The work decomposes into many independent units
- Tasks are file-scoped or record-scoped
- You want to throw parallelism at the problem
- Failure of one unit doesn't affect others
- The decomposition is the hard part, execution is mechanical

## Example Scenarios

### Codebase Refactor
```bash
mc decompose "Migrate all API endpoints from express-validator to zod"
# Decomposer scans src/routes/, creates one task per route file
# 47 tasks created, no dependencies (each file is independent)

mc spawn 10
# 10 workers spin up, start claiming tasks in parallel
# Each worker: claim task → create worktree → migrate one file → merge back → next

mc watch
# Watcher monitors. After initial batch completes:
# - Detects 3 failed tasks (complex edge cases) → returns to pending
# - Detects new type errors from migrations → re-decomposes "fix type errors in X, Y, Z"
# - Workers pick up new tasks automatically
```

### Test Generation
```bash
mc decompose "Achieve 80% test coverage" --context src/
# Decomposer runs coverage report, identifies uncovered paths
# Creates one task per uncovered function/module

mc spawn 5
mc watch
# Workers write tests independently
# Watcher periodically re-runs coverage
# If gaps remain → decomposer creates new tasks for still-uncovered paths
# Loop continues until 80% reached → intent satisfied → seed closed
```

### Documentation
```bash
mc decompose "Document all exported functions in src/lib/" --context src/lib/
# One task per file. Pure parallelism, zero dependencies.

mc spawn 8
# 8 workers churn through docs independently
# No watcher needed — one-shot work, no reactive loop required
```

## Ecosystem Table (Updated)

| Tool | CLI | npm | Purpose |
|------|-----|-----|---------|
| **Mulch** | `ml` | `@os-eco/mulch-cli` | Structured expertise management |
| **Seeds** | `sd` | `@os-eco/seeds-cli` | Git-native issue tracking |
| **Canopy** | `cn` | `@os-eco/canopy-cli` | Prompt management & composition |
| **Substrate** | — | `@os-eco/substrate` | Shared infrastructure (worktrees, tmux, runtimes, merge) |
| **Overstory** | `ov` | `@os-eco/overstory-cli` | Top-down multi-agent orchestration |
| **Mycelium** | `mc` | `@os-eco/mycelium-cli` | Bottom-up reactive agent swarm |
| **Sapling** | `sp` | `@os-eco/sapling-cli` | Headless coding agent |
| **Greenhouse** | `grhs` | `@os-eco/greenhouse-cli` | Autonomous development daemon |

### Updated Relationship Graph

```
greenhouse (polls GitHub → dispatches overstory OR mycelium → opens PRs)
  ├── overstory (top-down orchestration)
  │     ├── sapling (headless coding agent, alternative runtime)
  │     ├── substrate (worktrees, tmux, runtimes, merge)
  │     ├── mulch (expertise for agents)
  │     ├── seeds (issue tracking)
  │     └── canopy (prompt templates)
  └── mycelium (bottom-up reactive swarm)
        ├── substrate (worktrees, tmux, runtimes, merge)
        ├── mulch (expertise for workers)
        └── seeds (intent-level tracking)
```

## Branding

Following the forest-layer metaphor:

- **Name:** Mycelium
- **Metaphor:** The underground fungal network — coordinates resource distribution across an entire forest with no central control
- **Color:** TBD — likely a deep purple or dark earth tone (distinct from existing browns and greens)
- **Position:** Literally underneath the Overstory. Mulch feeds them both. The ecosystem narrative is airtight.

## Implementation Sequence

### Phase 0: Substrate Extraction
1. Create `substrate/` sub-repo
2. Extract from Overstory: worktree manager, tmux integration, runtime adapters (claude + sapling), merge resolver, mulch client
3. Refactor Overstory to depend on `@os-eco/substrate`
4. Verify Overstory still passes all 3,364 tests
5. Publish `@os-eco/substrate`

### Phase 1: Core (Mycelium v0.1)
1. `mc init` — scaffold .mycelium/, SQLite pool, config
2. `mc decompose` — recursive decomposition via Claude Code
3. Task pool — SQLite with atomic claim, TTL expiry, soft dependencies
4. `mc spawn` — worker loop (claim → worktree → execute → merge → next)
5. `mc watch` — state surface monitor + re-decomposition trigger
6. `mc status` / `mc tasks` / `mc show` — observability
7. `mc stop` — worker termination
8. Seeds integration — intent = seed issue, auto-close on satisfaction
9. Mulch integration — expertise loading per task

### Phase 2: Polish
1. `mc doctor` — health checks
2. `mc logs` — worker execution logs
3. `mc retry` / `mc pool reset` — manual intervention
4. `mc prime` / `mc sync` / `mc upgrade` — ecosystem conventions
5. Branding alignment (help screens, colors, icons)
6. Shell completions
7. `--json` output on all commands

### Phase 3: Greenhouse Integration
1. Greenhouse dispatch config for mycelium
2. `grhs ship` support for mycelium-originated work
3. Label-based routing (parallel → mycelium, complex → overstory)

## Open Questions

1. **Substrate scope** — Should substrate also extract the Seeds/Canopy client wrappers, or just the infrastructure layer (worktrees, tmux, runtimes, merge)?
2. **Decomposer persistence** — The decomposer runs as a Claude Code instance. Should it terminate after initial decomposition and re-launch for re-decomposition? Or stay alive (like Overstory's coordinator)?
3. **Worker prompt injection** — How does the task payload get to the worker? Overlay CLAUDE.md (like Overstory)? Or tmux send-keys with the prompt? The worker loops claiming tasks, so it needs a new prompt per task.
4. **Merge ordering** — When 10 workers finish near-simultaneously, merge order matters. FIFO by completion time? Or dependency-aware ordering?
5. **Brand color** — What color for Mycelium in the forest palette?
