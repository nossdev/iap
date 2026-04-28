# @nossdev/iap

> Thin Capacitor IAP orchestrator that pairs with [Attesto](https://attesto.nossdev.com) for receipt validation.

**Status: pre-alpha — do not use in production.**

`@nossdev/iap` is a framework-agnostic TypeScript library that orchestrates the in-app purchase flow on the client side of a Capacitor app. It wraps `@capgo/native-purchases` and coordinates with your backend, which in turn calls Attesto for receipt validation.

The library handles: native purchase calls, backend verification, deferred acknowledgement, entitlement caching (via Capacitor Preferences), restore flow, recovery of unfinished transactions, and reactive events for UI updates. It does not replace your state management, ship paywall UI, or talk to Attesto directly.

## Capacitor support matrix

| `@nossdev/iap` | Capacitor | `@capgo/native-purchases` | Status |
|---|---|---|---|
| 0.x | 5.x | ^5.x | Initial target |

See [PLAN.md](./PLAN.md) for the full design.

## Quickstart

(Coming after Phase 1.)

## License

MIT — see [LICENSE](./LICENSE).
