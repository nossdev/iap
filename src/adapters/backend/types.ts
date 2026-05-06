import { z } from 'zod';
import { configuredProductsArraySchema } from '../../types/config.js';
import type { EntitlementBase } from '../../types/entitlement.js';
import { entitlementBaseSchema } from '../../types/entitlement.js';
import type { ConfiguredProduct, ProductType } from '../../types/product.js';

// ----- Request types (constructed by the library; static TS types are sufficient) -----

export interface VerifyAppleRequest {
  productId: string;
  /** Apple StoreKit transaction id (numeric string). */
  transactionId: string;
  type: ProductType;
}

export interface VerifyGoogleRequest {
  productId: string;
  /** Google Play `purchaseToken`. */
  purchaseToken: string;
  /** Application package name (e.g. `com.example.app`). */
  packageName: string;
  type: ProductType;
}

/** A single entry in a restore batch. Discriminated by `platform`. */
export type RestoreRequestTransaction =
  | {
      platform: 'apple';
      productId: string;
      transactionId: string;
    }
  | {
      platform: 'google';
      productId: string;
      purchaseToken: string;
      packageName: string;
    };

export interface RestoreRequest {
  transactions: RestoreRequestTransaction[];
}

// ----- Response schemas (validated; consumer fields ride along via .passthrough()) -----

/**
 * Validates the EntitlementBase shape but lets consumer-defined fields pass
 * through unstripped. The HttpBackendAdapter casts results to TEntitlement
 * at the public boundary — same pattern as EntitlementCache.
 */
const passthroughEntitlementSchema = entitlementBaseSchema.passthrough();

const verifiedTransactionSchema = z
  .object({
    id: z.string(),
    productId: z.string(),
    /** ISO 8601 timestamp; null for non-expiring transactions. */
    expiresAt: z.string().nullable().optional(),
  })
  .passthrough();

const verifySuccessSchema = z
  .object({
    valid: z.literal(true),
    entitlements: z.array(passthroughEntitlementSchema),
    transaction: verifiedTransactionSchema,
  })
  .passthrough();

const verifyFailureSchema = z
  .object({
    valid: z.literal(false),
    /** Stable machine-readable code, e.g. "TRANSACTION_NOT_FOUND". */
    error: z.string(),
    /** Optional human-readable detail. */
    message: z.string().optional(),
  })
  .passthrough();

export const verifyResponseSchema = z.discriminatedUnion('valid', [
  verifySuccessSchema,
  verifyFailureSchema,
]);

const restoreSuccessSchema = z
  .object({
    valid: z.literal(true),
    entitlements: z.array(passthroughEntitlementSchema),
  })
  .passthrough();

export const restoreResponseSchema = z.discriminatedUnion('valid', [
  restoreSuccessSchema,
  verifyFailureSchema,
]);

export const entitlementsResponseSchema = z
  .object({ entitlements: z.array(passthroughEntitlementSchema) })
  .passthrough();

/**
 * Backend product-manifest response. Mirrors the entitlements envelope
 * shape (`{ entitlements: [...] }`) for API consistency. The inner array
 * is validated against the same `configuredProductSchema` used at config
 * parse time, so a backend that drifts from the schema fails loudly.
 */
export const productManifestResponseSchema = z
  .object({ products: configuredProductsArraySchema })
  .passthrough();

// ----- Public response types (plain TS; runtime schemas above passthrough extras at parse time) -----
//
// Defined as plain TS interfaces rather than `z.infer<...>` because Zod's
// `.passthrough()` adds `[k: string]: unknown` to the inferred type, which
// TS treats as overriding named property types — so consumer code reading
// `result.entitlements` would receive `unknown`. The runtime schemas above
// still passthrough at parse time, so backend-defined extras ARE preserved
// on the resolved object — consumers who want them just cast.
//
// The transaction echo's shape is inlined (rather than referencing the
// separate `VerifiedTransaction` in `src/types/transaction.ts`) because the
// purchase orchestrator does its own `as VerifiedTransaction` cast when
// surfacing the value in `PurchaseResult` — the public type there is the
// canonical one.

/** Public response type for `verifyApple` / `verifyGoogle`, generic over the consumer's entitlement shape. */
export type VerifyResponse<TEntitlement extends EntitlementBase = EntitlementBase> =
  | {
      valid: true;
      entitlements: TEntitlement[];
      transaction: { id: string; productId: string; expiresAt?: string | null };
    }
  | { valid: false; error: string; message?: string };

/**
 * Restore response. Distinct from {@link VerifyResponse} because the
 * orchestrator never reads `transaction` on the restore path — the schema
 * accordingly omits any required transaction echo. Backends that include
 * a `transaction` (or any other field) on the success branch ride through
 * unmodified via top-level passthrough; consumers cast to read them.
 */
export type RestoreResponse<TEntitlement extends EntitlementBase = EntitlementBase> =
  | { valid: true; entitlements: TEntitlement[] }
  | { valid: false; error: string; message?: string };

// ----- BackendAdapter interface (transport-agnostic) -----

/**
 * Abstracts the consumer's backend so the orchestrator (Phase 4+) doesn't
 * depend on `fetch`. The default `HttpBackendAdapter` is HTTP/JSON via
 * `fetch`; consumers on GraphQL, gRPC-web, Supabase, Firebase, etc. supply
 * their own implementation via `config.backend.adapter`.
 *
 * All methods MUST validate response shape. Failures should throw IAPError
 * (HTTP impl uses BACKEND_UNAVAILABLE / BACKEND_TIMEOUT / BACKEND_AUTH_FAILED
 * / VERIFICATION_REJECTED depending on cause) — the orchestrator relies on
 * `IAPError.recoverable` to decide whether to surface a transient error or
 * abort the purchase flow.
 */
export interface BackendAdapter<TEntitlement extends EntitlementBase = EntitlementBase> {
  verifyApple(req: VerifyAppleRequest): Promise<VerifyResponse<TEntitlement>>;
  verifyGoogle(req: VerifyGoogleRequest): Promise<VerifyResponse<TEntitlement>>;
  /** GET current entitlements; library uses this for refresh + warm cache. */
  getEntitlements(): Promise<TEntitlement[]>;
  /**
   * Batch re-verify. Backend returns consolidated entitlements.
   *
   * Returns {@link RestoreResponse} (not {@link VerifyResponse}) — the orchestrator
   * does not consume any per-transaction echo on restore, so the response
   * shape intentionally omits the required `transaction` field that verify
   * has. Backends may still attach a `transaction` (or any other extras)
   * — they ride through via the schema's top-level passthrough.
   */
  restore(req: RestoreRequest): Promise<RestoreResponse<TEntitlement>>;
  /**
   * Optional: return the SKU manifest the app should register.
   *
   * When implemented, the library calls this during `initialize()` if the
   * consumer omitted `products` from `createIAP()` config — letting the
   * backend curate which SKUs are surfaced (feature flags, A/B mixes,
   * regional catalogs). Returned ids MUST still be pre-registered in App
   * Store Connect / Google Play Console; the manifest is a curated subset,
   * not a registration.
   */
  listProducts?(): Promise<ConfiguredProduct[]>;
}

/** Type guard; consumers passing a custom adapter via config get a runtime check. */
export function isBackendAdapter(value: unknown): value is BackendAdapter {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BackendAdapter>;
  return (
    typeof candidate.verifyApple === 'function' &&
    typeof candidate.verifyGoogle === 'function' &&
    typeof candidate.getEntitlements === 'function' &&
    typeof candidate.restore === 'function'
  );
}
