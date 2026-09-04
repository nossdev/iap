---
layout: home

hero:
  name: "@nosslabs/iap"
  text: "In-app purchases for Capacitor 7"
  tagline: "Thin orchestrator. Server-side validation via Attesto."
  image:
    src: /iap-logo.svg
    alt: "@nosslabs/iap"
  actions:
    - theme: brand
      text: Get Started
      link: /v7/guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/nossdev/iap

features:
  - icon: 🛡️
    title: Safety-first purchase flow
    details: Acknowledge native transactions ONLY after the backend confirms validation. No phantom grants if the network drops mid-purchase.
  - icon: 🔌
    title: Transport-agnostic
    details: HTTP/JSON default. Swap in a custom BackendAdapter for GraphQL, gRPC-web, Firebase, or Supabase without changing call sites.
  - icon: 🧬
    title: Generic entitlement type
    details: Bring your own TEntitlement. The library validates the base shape; your domain fields ride along through caches, events, and responses.
  - icon: ♻️
    title: At-least-once recovery
    details: Killed-mid-purchase transactions persist to local storage and re-verify on next launch. Users never end up paying for nothing.
  - icon: ⚡
    title: Reactive events
    details: Subscribe to entitlements-changed and wire a Pinia or React store in 5 lines. Frozen entitlement objects prevent accidental mutation.
  - icon: 🌐
    title: Web-friendly
    details: Web platform is no-op for purchases (rejects with PLATFORM_NOT_SUPPORTED). Cached entitlement reads still work for dev workflows.
---

::: tip You're viewing the **`7.x` (Capacitor 7)** docs
This is the maintenance line for Capacitor 7 apps. To install: `npm install @nosslabs/iap@^7 @capgo/native-purchases@lts-v7` (the `@latest-7` dist-tag tracks it). For Capacitor 8 — now on `@latest` — switch via the version dropdown above or jump straight to the [current docs (v8)](/). For Capacitor 5, see the [v5 docs](/v5/).
:::
