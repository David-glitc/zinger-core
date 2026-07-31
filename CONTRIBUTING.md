# Contributing

Thanks for helping improve Zinger Core.

## Ground rules

- Prefer **paper mode** when exercising the bot.
- Never commit `.env`, wallets, proxy credentials, or files under `data/` (except `data/.gitkeep`).
- Do not paste live keys, chat IDs, or funded addresses into issues or PRs.
- Keep PRs focused; separate refactors from behavior changes when you can.

## Local setup

```bash
git clone https://github.com/David-glitc/zinger-core.git
cd zinger-core
npm install
cd frontend && npm install && npm run build && cd ..
cp .env.example .env
# set AUTH_PASSWORD at minimum
npm start
# open http://localhost:3000/poly
```

Optional ML tooling lives under `ml/` (Python). Model weights and parquet datasets are not part of this repo; point `ZINGER_DATA_DIR` / `data/ml` at your own artifacts.

## Checks before opening a PR

- `npm run typecheck` (backend)
- `npm test` and `npm run test:perf`
- `npm run typecheck:frontend` if you changed `frontend/`
- Paper-mode smoke when behavior changes
- No absolute personal paths (`/home/...`) in new code
- No secrets in the diff

CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, perf budgets, and frontend typecheck/build on every push/PR to `main`.

## Scope of this repo

This is **Core only** (Express bot + operator dashboard + ML training code). The Pilot consumer app and public playground are maintained separately and are out of scope here.


## TypeScript status

Core and the operator UI are TypeScript (`.ts` / `.tsx`), run with `tsx`.

Most migrated modules still carry `// @ts-nocheck` while domain types in `src/types/` are checked under `tsconfig.types.json`. Prefer removing `nocheck` and adding real types when you touch a file.
