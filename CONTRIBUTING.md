# Contributing / 贡献指南

Thanks for considering a contribution — external PRs (notably from forks) are welcome and get real review. This doc states the workflow and, critically, **which checks you can run where**.

感谢考虑贡献。外部（尤其 fork）PR 欢迎且会被认真评审。本文说明工作流，以及最关键的一点：**哪些检查在哪里能跑**。

## Fork-PR workflow / Fork 提交流程

1. Fork the repo, create a branch off `main`（从 `main` 拉分支）.
2. `pnpm install` — inside a full `deepseek-harness` workspace checkout this links the private `@deepseek-ai/*` peers via `scripts/link-peers.mjs`; on a clean fork checkout it skips linking and **the two CI gates still run**.
3. Open the PR against `main`. Keep one logical change per PR; rebase onto `main` before the final push if it drifted.

## Which checks run where / 检查项与运行环境

| Check | Bare fork checkout | `deepseek-harness` workspace | CI (hosted runner) |
|---|---|---|---|
| `node scripts/check-messages.mjs` | ✅ | ✅ | ✅ |
| `node scripts/check-patterns.mjs` | ✅ | ✅ | ✅ |
| packaging smoke (peers optional + resolution) | ❌ (needs `npm pack`) | ✅ | ✅ |
| `pnpm typecheck` | ❌ (peers missing → TS2307) | ✅ | ❌ planned via peer-type snapshots |
| `pnpm test` | partial — a few suites need the peers; POSIX-only assertions are marked inline | ✅ 463 tests | ❌ planned (self-hosted, `push: main` only) |
| `pnpm bundle` | ❌ | ✅ | ❌ |

Run at least the first two before pushing — CI runs exactly those plus the packaging smoke. 字典/清洗两道门在任何干净检出上都能跑，push 前请务必先过；CI 跑的就是这两项加打包冒烟。

## Conventions / 约定

- **Commits**: conventional (`feat(scope):` / `fix(scope):` / `chore:` / `ci:`), Chinese or English body both fine.
- **i18n**: every user-visible string goes through the dictionary. Client: add the key to `src/client/locales/index.ts` (`KyzmemKey`) **and all three of zh/en/ru** — `Record<KyzmemKey, string>` makes a missing key a compile error. Server: `src/i18n/catalog/` + `check-messages.mjs` must stay balanced.
- **Client/server contract**: if your change adds fields to a route response, make them **optional on the client with a fallback** — the running app can mix a new client bundle with an old server process (this caused the v0.8.15 blank-panel incident; see `docs/audit-2026-10-18.md` §2). Never read a new response field without `?? fallback`.
- **Error states**: a failed fetch must render a failure state with a retry — never `.catch(() => setEmpty())`. Use the `LoadFailedLine` component (client) or the `failed` + `EmptyState` pattern (main list / spiral are the reference implementations).
- **Tests**: add/adjust specs for behaviour changes. POSIX-only assertions (file modes, path separators) must be guarded with `process.platform !== 'win32'` so Windows contributors see real greens.

## Reporting bugs / 报 bug

GitHub issues, in Chinese or English. Include: plugin version (`npm ls dsh-kyzmem` or the DSH plugin center), DSH Desktop version + platform, what you did, what you expected, what happened. For the panel UI, a screenshot of the DevTools console (right-click the panel → inspect) saves a round-trip.

Security issues: see [SECURITY.md](SECURITY.md) — please do not report vulnerabilities in public issues.
