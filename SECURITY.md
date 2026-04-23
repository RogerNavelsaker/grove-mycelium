# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

Only the latest release on the current major version line receives security updates.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/jayminwest/mycelium/security/advisories).

1. Go to the [Security Advisories page](https://github.com/jayminwest/mycelium/security/advisories)
2. Click **"New draft security advisory"**
3. Fill in a description of the vulnerability, including steps to reproduce if possible

### Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Initial assessment**: Within 7 days
- **Fix or mitigation**: Within 30 days for confirmed vulnerabilities

We will keep you informed of progress throughout the process.

## Scope

Mycelium is a CLI tool that spawns stateless worker agents via tmux, manages a SQLite task pool, and operates git worktrees on the local filesystem. The following are considered security issues:

- **Command injection** -- Unsanitized input passed to `Bun.spawn` or shell execution
- **Path traversal** -- Accessing files outside the intended project or `.mycelium/` directory
- **Arbitrary file access** -- Reading or writing files the user did not intend
- **Symlink attacks** -- Following symlinks to unintended locations
- **Temp file races** -- TOCTOU vulnerabilities in temporary file handling
- **Worker escape** -- A worker accessing files outside its designated worktree
- **SQL injection** -- Crafted task payloads that manipulate the SQLite task pool

The following are generally **not** in scope:

- Denial of service via large input (Mycelium is a local tool, not a service)
- Issues that require the attacker to already have local shell access with the same privileges as the user
- Social engineering or phishing
- Costs incurred from spawning many workers (this is an operational concern, not a security vulnerability)

## Security Measures

Mycelium already implements several hardening measures:

- Atomic task claims via SQLite transactions to prevent double-execution
- Workers operate in isolated git worktrees
- SQLite WAL mode with busy timeouts for safe concurrent access
- TTL-based task expiry to reclaim stalled work

If you believe any of these measures can be bypassed, please report it through the process above.
