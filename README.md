# Zinger Core

Polymarket BTC/ETH up-or-down trading bot with paper and live modes, operator dashboard, optional Telegram command center, and ML helpers.

> This public tree is **Core only**. Runtime ledgers, wallets, and production deploy secrets are not included.

## Features

- Paper and live Polymarket CLOB trading (5m / 15m / 30m / 1h windows when listed)
- Signal + optional ML overlays, Kelly/certainty sizing, TP/SL / hold-to-settle plans
- Regime governor and LLM optimizer hooks (OpenRouter)
- Operator UI (`frontend/`) served from Core at `/poly`
- Optional Telegram control surface

## Quick start (paper)

```bash
git clone <repo-url> zinger-core
cd zinger-core
npm install
cd frontend && npm install && npm run build && cd ..
cp .env.example .env
# set AUTH_PASSWORD=...
npm start
```

Open `http://localhost:3000/poly`, sign in with `AUTH_PASSWORD`, keep mode on **paper**.

## Configuration

See [`.env.example`](.env.example). Important knobs:

| Variable | Purpose |
|----------|---------|
| `AUTH_PASSWORD` | Dashboard login |
| `OPENROUTER_API_KEY` | Optional LLM governor/optimizer |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional Telegram |
| `CLOB_PROXY_URL` | Optional SOCKS/HTTP egress for order writes |
| `ZINGER_DATA_DIR` | Override runtime data directory (default `./data`) |

Live trading requires a wallet file created by Core under `data/wallet.json` (gitignored) and Polymarket-ready collateral. Start paper-first.

## Layout

```
index.js          # process entry
src/              # Express API, Polymarket bot, AI, Telegram
frontend/         # Vite operator dashboard
ml/               # Training / export scripts (no weights in-git)
docker/           # Optional container samples
data/             # Runtime only (gitignored; .gitkeep placeholder)
```

## Docker

```bash
cp .env.example .env
# fill OPENROUTER_API_KEY / AUTH_PASSWORD as needed
docker compose -f docker/docker-compose.yml up --build
```

## Security

Read [SECURITY.md](SECURITY.md). Never publish funded keys or live `.env` files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
