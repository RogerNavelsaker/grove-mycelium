# Contributing to Mycelium

Thanks for your interest in contributing to Mycelium! This guide covers everything you need to get started.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/mycelium.git
   cd mycelium
   ```
3. **Install** dependencies:
   ```bash
   bun install
   ```
4. **Link** the CLI for local development:
   ```bash
   bun link
   ```
5. **Create a branch** for your work:
   ```bash
   git checkout -b fix/description-of-change
   ```

## Branch Naming

Use descriptive branch names with a category prefix:

- `fix/` -- Bug fixes
- `feat/` -- New features
- `docs/` -- Documentation changes
- `refactor/` -- Code refactoring
- `test/` -- Test additions or fixes

## Build & Test Commands

```bash
bun test                           # Run all tests
bun test src/pool.test.ts          # Run a single test file
biome check .                      # Lint + format check
biome check --write .              # Auto-fix lint + format issues
tsc --noEmit                       # Type check
bun test && biome check . && tsc --noEmit  # All quality gates
```

Always run all three quality gates before submitting a PR.

## TypeScript Conventions

Mycelium is a strict TypeScript project that runs directly on Bun (no build step).

### Strict Mode

- `noUncheckedIndexedAccess` is enabled -- always handle possible `undefined` from indexing
- No `any` -- use `unknown` and narrow, or define proper types

### Dependencies

- Minimal runtime deps: only `chalk` and `commander`
- Use Bun built-in APIs: `bun:sqlite` for databases, `Bun.spawn` for subprocesses, `Bun.file` for file I/O, `Bun.write` for writes

### Formatting

- **Tab indentation** (enforced by Biome)
- **100 character line width** (enforced by Biome)
- Biome handles import organization automatically

### File Organization

- All shared types go in `src/types.ts`
- Each CLI command gets its own file in `src/commands/`
- Import with `.ts` extensions

## Testing Conventions

- **No mocks.** Tests use real filesystems, real SQLite, and real git repos.
- Create temp directories with `mkdtemp` for file I/O tests
- Use `:memory:` or temp file databases for SQLite tests
- Clean up in `afterEach`
- Tests are colocated with source files: `src/pool.test.ts` alongside `src/pool.ts`

Example test structure:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it, expect } from "bun:test";

describe("my-feature", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "mycelium-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  it("does the thing", async () => {
    // Write real files, run real code, assert real results
  });
});
```

## Adding a New Command

1. Create `src/commands/<name>.ts`
2. Register the command in `src/index.ts`
3. Add tests in `src/commands/<name>.test.ts`
4. Update the CLI Reference table in `README.md`

## Commit Message Style

Use concise, descriptive commit messages:

```
fix: resolve TTL expiry race in task pool
feat: add --dry-run flag to decompose command
docs: update CLI reference with new spawn options
```

Prefix with `fix:`, `feat:`, or `docs:` when the category is clear. Plain descriptive messages are also fine.

## Pull Request Expectations

- **One concern per PR.** Keep changes focused -- a bug fix, a feature, a refactor. Not all three.
- **Tests required.** New features and bug fixes should include tests. See the testing conventions above.
- **Passing CI.** All PRs must pass CI checks (lint + typecheck + test) before merge.
- **Description.** Briefly explain what the PR does and why. Link to any relevant issues.

## Reporting Issues

Use [GitHub Issues](https://github.com/jayminwest/mycelium/issues) for bug reports and feature requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
