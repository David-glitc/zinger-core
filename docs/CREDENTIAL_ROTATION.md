# Credential rotation checklist (ops)

Run this on the **private** ops machine after the public Core cut exists. Do not put real secrets in the public repo.

- [ ] Rotate `OPENROUTER_API_KEY`
- [ ] Rotate Telegram `TELEGRAM_BOT_TOKEN` (and confirm `TELEGRAM_CHAT_ID`)
- [ ] Rotate `AUTH_PASSWORD` / `AUTH_SECRET`
- [ ] Rotate CLOB proxy credentials (`CLOB_PROXY_URL` user/pass)
- [ ] Rotate any DNS/API deploy keys that lived beside this project
- [ ] Confirm `data/wallet.json` never left the private host; if unsure, treat as compromised and migrate funds to a new wallet
- [ ] Confirm public GitHub repo history has a single clean commit with no `data/` blobs (`git rev-list --objects --all | grep data/` should be empty aside from `.gitkeep` if present)
- [ ] Keep private ops remote private; do not force-push private history to the public remote
