# Contributing to Zinger Core

Thanks for contributing. By opening a pull request or issue, you agree that your
contributions are licensed under the **Apache License 2.0** (see [`LICENSE`](LICENSE)
and [`NOTICE`](NOTICE)).

Please also follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Scope

This repository is **Polymarket Core only**:

| In scope | Out of scope |
|----------|--------------|
| `src/` bot + Express API | Pilot consumer app |
| `frontend/` operator UI | Public playground |
| `ml/` training **code** (no weights) | Live deploy/host secrets |
| Docs, Docker samples, tests | Runtime `data/` ledgers / wallets |

Do not open PRs that add live keys, proxy credentials, personal host paths, or
trading ledgers.

## Ground rules

1. **Paper-first** — develop and demo against paper mode. Live trading is opt-in and your own risk.
2. **No secrets** — never commit `.env`, `data/wallet.json`, proxy URLs with credentials, Telegram tokens, or OpenRouter keys. Use `.env.example` placeholders only.
3. **No personal ops cruft** — no `/home/...` absolute paths, private IPs, or Contabo/Vercel project IDs in code or docs.
4. **Focused PRs** — one concern per PR. Prefer separate PRs for refactors vs behavior changes.
5. **Do not paste secrets into issues** — if you hit an auth/wallet bug, redact keys and addresses.
6. **Respect CI** — PRs should keep `typecheck`, unit tests, and perf budgets green when GitHub Actions is available; always run locally before opening.

## Local setup

```bash
git clone https://github.com/David-glitc/zinger-core.git
cd zinger-core
npm install
cd frontend && npm install && npm run build && cd ..
cp .env.example .env
# set AUTH_PASSWORD=...
npm start
# open http://localhost:3000/poly  (paper mode)
```

Optional ML tooling lives under `ml/` (Python). Point `ZINGER_DATA_DIR` / `data/ml` at your own artifacts — weights and parquet are not in-git.

## Development workflow

1. Fork (or branch from `main`).
2. Create a branch: `feat/...`, `fix/...`, or `docs/...`.
3. Make changes; keep TypeScript modules typed when you can (prefer removing `// @ts-nocheck` on files you touch).
4. Run checks (below).
5. Open a PR against `main` with a short description of **why**.

### Required checks before a PR

```bash
npm run typecheck
npm test
npm run test:perf
# if you changed frontend/
npm run typecheck:frontend
```

| Check | Command |
|-------|---------|
| Backend types | `npm run typecheck` |
| Unit tests | `npm test` |
| Perf budgets | `npm run test:perf` |
| Frontend types | `npm run typecheck:frontend` |
| Local CI mirror | `npm run ci` |

CI workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Coding standards

- **Language:** TypeScript (ESM). Entry is `tsx index.ts`. Frontend is React + Vite (TSX).
- **Imports:** keep NodeNext-style `.js` extensions in backend imports that resolve to `.ts` files.
- **Style:** match surrounding code; no drive-by reformat of unrelated files.
- **Tests:** add or update unit tests for pure helpers you change (`fees`, `windows`, `kelly`, `auth`, etc.). If you change a hot path, keep or adjust `tests/perf` budgets deliberately.
- **Config:** new env knobs belong in `.env.example` with empty/safe placeholders and a one-line comment.
- **Logging:** never log private keys, full proxy URLs with passwords, or session tokens.

## Pull request rules

- Title under ~60 characters; say what changed.
- Body: problem → approach → how you tested (commands run).
- Link related issues when applicable.
- Do not force-push over reviewed history unless asked.
- Maintainers may request splits if a PR mixes unrelated work.

## Issue rules

- Use a clear title and steps to reproduce.
- Include Core version / commit SHA, Node version, OS, paper vs live (prefer paper).
- Redact secrets. Prefer screenshots of the UI over pasted `.env` dumps.
- Feature requests should state the user problem, not only an implementation idea.

## Security

Security-sensitive reports go through [`SECURITY.md`](SECURITY.md) — not public issues.

## License of contributions

Unless you state otherwise in writing, every contribution (code, docs, tests, examples)
is submitted under the Apache License 2.0, and you certify you have the right to
submit it (see DCO-style expectation: you authored it or have permission to contribute it).

## Questions

Open a discussion issue labeled `question`, or comment on an existing related issue.
