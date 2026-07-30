# Security Policy

## Supported versions

Report issues against the latest `main` (or public Core release branch) of this repository.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports.

Email or privately message the maintainers with:

- a short description of the issue
- steps to reproduce
- impact assessment (auth bypass, key leakage, remote code execution, etc.)
- any suggested fix

We will acknowledge receipt when possible and coordinate a fix before disclosure.

## Out of scope for this OSS tree

This repository is the **Core** application (bot + operator UI). It deliberately does **not** ship:

- funded wallet private keys (`data/wallet.json`)
- live `.env` credentials (Telegram, OpenRouter, CLOB proxies, auth secrets)
- live/paper trading ledgers under `data/`
- production deploy secrets

If you run Core with live trading, treat your VPS, `.env`, and wallet files as high-value secrets. Never paste them into issues, PRs, or logs you intend to publish.

## Safe defaults for contributors

- Start in **paper** mode.
- Use `.env.example` placeholders only.
- Do not commit anything under `data/` except an empty `.gitkeep`.
