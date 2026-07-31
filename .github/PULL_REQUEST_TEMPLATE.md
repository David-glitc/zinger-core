## Summary

<!-- What changed and why (1–3 bullets). -->

-

## Checklist

- [ ] Paper-mode only in examples / screenshots (no live keys)
- [ ] No secrets, wallets, or personal host paths in the diff
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:perf` (if hot-path code changed)
- [ ] `npm run typecheck:frontend` (if `frontend/` changed)
- [ ] Docs / `.env.example` updated when behavior or config changed

## Test plan

<!-- Commands you ran, and what you observed. -->

```bash
npm run ci
```
