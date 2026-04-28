# @nossdev/iap

> Thin Capacitor IAP orchestrator that pairs with [Attesto](https://attesto.nossdev.com) for receipt validation.

**Status: pre-alpha — do not use in production.**

`@nossdev/iap` is a framework-agnostic TypeScript library that orchestrates the in-app purchase flow on the client side of a Capacitor app. It wraps [`cordova-plugin-purchase`](https://github.com/j3k0/cordova-plugin-purchase) (on Capacitor 5) and coordinates with your backend, which in turn calls Attesto for receipt validation.

The library handles: native purchase calls, backend verification, deferred acknowledgement (`tx.finish()` only after the backend confirms), entitlement caching (via Capacitor Preferences), restore flow, recovery of unfinished transactions, and reactive events for UI updates. It does not replace your state management, ship paywall UI, or talk to Attesto directly.

## Capacitor support matrix

| `@nossdev/iap` | Capacitor | Plugin | Status |
|---|---|---|---|
| 0.x | 5.x | `cordova-plugin-purchase ^13.x` | **v0.1.0 target** — Infopathy production. |
| 1.x | 7.x | `@capgo/native-purchases 7.16.2` | Future — Cap 7 adapter is preserved in git history (commit `f1d20ed`). |
| 2.x | 8.x | `@capgo/native-purchases ^8.x` | Future. |

## Known limitations (v0.1.0)

- **Capacitor 5 only.** Cap 6/7/8 support is tracked for v1.x. The v7 adapter is preserved in git history; restoration is a peer-dep bump + adapter swap (see `PLAN.md` §18).
- **Web platform is no-op for purchases.** `iap.purchase()` rejects with `PLATFORM_NOT_SUPPORTED` on web; entitlement reads still work against the local cache.
- **Pre-alpha API.** Expect breaking changes until a real production purchase has gone end-to-end.

## Quickstart

(Coming after Phase 1 wraps up. See `PLAN.md` for the full design.)

## Development

```bash
mise install        # Node 22 + npm 10
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm test            # vitest run
npm run build       # tsup → dist/index.{js,cjs,d.ts}
```

## License

MIT — see [LICENSE](./LICENSE).
