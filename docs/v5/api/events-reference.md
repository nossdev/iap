# Events reference

```typescript
import type { EventMap, EventName, EventPayload, Unsubscribe } from '@nosslabs/iap';
```

Type definitions for the event system. For a guide-style introduction with usage patterns, see [Events](/v5/guide/events).

## `EventMap`

Generic over your entitlement type. Maps event name → payload shape.

```typescript
interface EventMap<TEntitlement extends EntitlementBase = EntitlementBase> {
  ready:                  undefined;
  'purchase-started':     { productId: string };
  'purchase-success':     { productId: string; transaction: VerifiedTransaction };
  'purchase-cancelled':   { productId: string };
  'purchase-pending':     { productId: string };
  'purchase-failed':      { productId: string; error: IAPError };
  'verification-failed':  { productId: string; error: IAPError };
  'restore-started':      undefined;
  'restore-completed':    { restored: number; entitlements: TEntitlement[] };
  'entitlements-changed': { entitlements: TEntitlement[]; previous: TEntitlement[] };
  'price-stale':          { productId: string; lastFetchedAt: number };
  error:                  { error: IAPError };
}
```

## `EventName`

```typescript
type EventName<T extends EntitlementBase = EntitlementBase> = keyof EventMap<T>;
```

The union of all valid event name strings.

## `EventPayload`

```typescript
type EventPayload<
  K extends EventName<T>,
  T extends EntitlementBase = EntitlementBase,
> = EventMap<T>[K];
```

Look up the payload type for a given event name. `iap.on()` uses this internally so handlers are typed automatically; you rarely need to reference it directly.

## `Unsubscribe`

```typescript
type Unsubscribe = () => void;
```

The function returned by `iap.on()`. Call it to detach the handler.

## Subscribing — typed

`iap.on` is generic over the event name, so handlers infer their payload:

```typescript
const off = iap.on('purchase-success', ({ productId, transaction }) => {
  // productId:   string
  // transaction: VerifiedTransaction
});
```

Unknown event names are a TypeScript error:

```typescript
iap.on('did-something', () => {}); // ❌ Argument of type '"did-something"' is not assignable
```

## Custom entitlements

Pass `TEntitlement` to `createIAP` and event payloads pick it up:

```typescript
interface MyEntitlement extends EntitlementBase {
  tier: 'basic' | 'pro';
}

const iap = createIAP<MyEntitlement>(config);

iap.on('entitlements-changed', ({ entitlements }) => {
  // entitlements: MyEntitlement[]
  entitlements[0].tier; // ← typed
});

iap.on('restore-completed', ({ restored, entitlements }) => {
  // entitlements: MyEntitlement[]
});
```

## Ordering

For the canonical event ordering within a flow (purchase, restore, refresh), see [Events guide → ordering guarantees](/v5/guide/events#ordering-guarantees).

## See also

- [Events guide](/v5/guide/events) — full payload semantics with examples
- [`IAP.on`](/v5/api/iap-instance#on-event-handler) — the `on` method signature
