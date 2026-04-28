import { z } from 'zod';
import type { EntitlementBase } from '../../types/entitlement.js';
import { entitlementBaseSchema } from '../../types/entitlement.js';
import type { ProductType } from '../../types/product.js';

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
    /** ISO 8601 timestamp the backend recorded the verification. */
    verifiedAt: z.string().optional(),
  })
  .passthrough();

const verifySuccessSchema = z.object({
  valid: z.literal(true),
  entitlements: z.array(passthroughEntitlementSchema),
  transaction: verifiedTransactionSchema,
});

const verifyFailureSchema = z.object({
  valid: z.literal(false),
  /** Stable machine-readable code, e.g. "TRANSACTION_NOT_FOUND". */
  error: z.string(),
  /** Optional human-readable detail. */
  message: z.string().optional(),
});

export const verifyResponseSchema = z.discriminatedUnion('valid', [
  verifySuccessSchema,
  verifyFailureSchema,
]);

export const entitlementsResponseSchema = z.object({
  entitlements: z.array(passthroughEntitlementSchema),
});

// ----- Inferred response types (use these for typing; cast TEntitlement at adapter boundary) -----

type ZodVerifySuccess = z.infer<typeof verifySuccessSchema>;
type ZodVerifyFailure = z.infer<typeof verifyFailureSchema>;

/** Public response type, generic over the consumer's entitlement shape. */
export type VerifyResponse<TEntitlement extends EntitlementBase = EntitlementBase> =
  | (Omit<ZodVerifySuccess, 'entitlements'> & { entitlements: TEntitlement[] })
  | ZodVerifyFailure;

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
  /** Batch re-verify. Backend returns consolidated entitlements. */
  restore(req: RestoreRequest): Promise<VerifyResponse<TEntitlement>>;
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
