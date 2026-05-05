import { z } from 'zod';
import type { HttpRequest } from '../adapters/backend/http-client.js';

export const productTypeSchema = z.enum(['subscription', 'product', 'consumable']);

const configuredProductSchema = z.object({
  id: z.string().min(1),
  type: productTypeSchema,
  /**
   * Optional. Used only by the Android native adapter to disambiguate which
   * base plan to purchase for multi-plan subscription products (Google Play
   * Billing). iOS ignores it. When omitted on Android, the native adapter
   * falls back to `native.getOffer()` (the default offer) — fine for
   * single-plan subscriptions and for non-subscription products.
   *
   * Recommended to set explicitly when a single subscription product has
   * multiple base plans (e.g. monthly + yearly under one product id).
   */
  androidPlanId: z.string().min(1).optional(),
});

/**
 * Array form. Reused by `productManifestResponseSchema` (HTTP) and by the
 * runtime guard in `createIAP.initialize()` for backend-supplied manifests.
 */
export const configuredProductsArraySchema = z.array(configuredProductSchema).min(1);

const backendEndpointsSchema = z
  .object({
    /**
     * Optional. Set when the consumer supports iOS purchases. iOS-less
     * (e.g. Android-only) configs may omit it; the HTTP adapter will throw
     * `INVALID_CONFIG` at runtime if `verifyApple()` is invoked without this
     * endpoint configured. At least one of `verifyApple` or `verifyGoogle`
     * must be set.
     */
    verifyApple: z.string().min(1).optional(),
    /**
     * Optional. Set when the consumer supports Android purchases.
     * Android-less (e.g. iOS-only) configs may omit it; the HTTP adapter will
     * throw `INVALID_CONFIG` at runtime if `verifyGoogle()` is invoked
     * without this endpoint configured. At least one of `verifyApple` or
     * `verifyGoogle` must be set.
     */
    verifyGoogle: z.string().min(1).optional(),
    entitlements: z.string().min(1),
    restore: z.string().min(1),
    /**
     * Optional. When set, the library fetches the SKU manifest from this
     * endpoint during `initialize()` if `products` is omitted from config.
     * See `docs/guide/backend-contract.md` for the response shape.
     */
    products: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.verifyApple && !data.verifyGoogle) {
      // Attach to the object root rather than one of the two fields — the
      // constraint is cross-field, so naming a single path is misleading
      // (a developer reading "verifyApple: ..." may add only that and miss
      // that verifyGoogle would also satisfy the constraint).
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'At least one of backend.endpoints.verifyApple or backend.endpoints.verifyGoogle must be set.',
        path: [],
      });
    }
  });

const backendConfigSchema = z
  .object({
    /**
     * Custom backend transport. If provided, all HTTP-specific fields below
     * are ignored and the library uses this object directly for backend
     * operations. Must implement `BackendAdapter`.
     */
    adapter: z.unknown().optional(),

    // ----- HTTP-specific fields (used when `adapter` is not provided) -----
    baseUrl: z.string().url().optional(),
    endpoints: backendEndpointsSchema.optional(),
    /**
     * Returns auth headers to merge into every backend request. Called fresh
     * per request so token refresh works automatically. Type is checked at
     * runtime via shape guard, not zod (zod can't validate function contracts).
     */
    getAuthHeaders: z.unknown().optional(),
    /** Pre-send request transform. See {@link BackendConfig} for the typed shape. */
    requestTransform: z.unknown().optional(),
    /** Post-receive response transform. See {@link BackendConfig} for the typed shape. */
    responseTransform: z.unknown().optional(),
    entitlementSchema: z.unknown().optional(),

    // ----- Common (apply to both HTTP and custom adapters where relevant) -----
    timeoutMs: z.number().int().positive().default(10_000),
    retries: z.number().int().min(0).max(5).default(2),
  })
  .superRefine((data, ctx) => {
    // When no custom adapter, HTTP fields are required.
    if (data.adapter !== undefined) return;
    if (!data.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backend.baseUrl is required when no custom adapter is provided.',
        path: ['baseUrl'],
      });
    }
    if (!data.endpoints) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backend.endpoints is required when no custom adapter is provided.',
        path: ['endpoints'],
      });
    }
    if (typeof data.getAuthHeaders !== 'function') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'backend.getAuthHeaders must be a function (() => Record<string, string> | Promise<Record<string, string>>) when no custom adapter is provided.',
        path: ['getAuthHeaders'],
      });
    }
  });

const storageConfigSchema = z.object({
  type: z.enum(['preferences', 'memory', 'custom']).default('preferences'),
  namespace: z.string().min(1).default('nossdev_iap'),
  adapter: z.unknown().optional(),
});

const optionsConfigSchema = z.object({
  refreshOnResume: z.boolean().default(true),
  entitlementCacheTtlMs: z
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  recoverUnfinishedTransactions: z.boolean().default(true),
  /**
   * Cap on how many unfinished transactions recovery inspects per launch.
   * Defends against pathological growth if the consumer's backend has been
   * down for an extended period and the unfinished list keeps growing.
   * Excess entries stay in storage and are processed on subsequent launches.
   */
  recoveryMaxBatch: z.number().int().positive().default(50),
  productPriceCacheTtlMs: z
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
  logger: z.unknown().optional(),
});

export const iapConfigSchema = z
  .object({
    /**
     * Static SKU manifest. Optional: when omitted, the library calls
     * `backend.adapter.listProducts()` (custom adapter) or GETs
     * `backend.endpoints.products` (HTTP) during `initialize()`. Configs
     * without either path throw `INVALID_CONFIG` at parse time.
     */
    products: z.array(configuredProductSchema).min(1).optional(),
    backend: backendConfigSchema,
    storage: storageConfigSchema.default({ type: 'preferences', namespace: 'nossdev_iap' }),
    options: optionsConfigSchema.default({
      refreshOnResume: true,
      entitlementCacheTtlMs: 60 * 60 * 1000,
      recoverUnfinishedTransactions: true,
      recoveryMaxBatch: 50,
      productPriceCacheTtlMs: 24 * 60 * 60 * 1000,
      logLevel: 'info',
    }),
  })
  .superRefine((data, ctx) => {
    if (data.products !== undefined) return;
    // No static products → the backend must be able to supply them.
    // Adapter takes precedence: if `adapter` is provided, the HTTP fields are
    // ignored everywhere else, so we ignore them here too. The HTTP path is
    // only consulted when no custom adapter is set.
    const adapter = data.backend.adapter as { listProducts?: unknown } | undefined;
    const adapterCanList = adapter && typeof adapter.listProducts === 'function';
    const httpCanList = !data.backend.adapter && data.backend.endpoints?.products;
    if (!adapterCanList && !httpCanList) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'products is required unless the backend can supply it: set backend.endpoints.products (HTTP) or implement listProducts() on a custom adapter.',
        path: ['products'],
      });
    }
  });

type RawBackendConfig = z.infer<typeof backendConfigSchema>;
type RawBackendConfigInput = z.input<typeof backendConfigSchema>;

/**
 * Replace the schema's `unknown` typings for function-shaped fields with
 * their precise TS contracts. The schema captures the *structural* shape
 * and runtime validates "is a function" via `superRefine`; this overlay
 * gives consumers proper IDE autocomplete and removes the need for
 * `as never` casts inside the HTTP adapter.
 *
 * Zod's `z.function()` would type these as `(...args: unknown[]) => unknown`
 * which is too wide, and zod can't validate a function *contract* at runtime
 * anyway — only the existence of a function reference.
 */
type FunctionTypedBackendOverlay = {
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  requestTransform?: (req: HttpRequest) => HttpRequest | Promise<HttpRequest>;
  responseTransform?: (raw: unknown) => unknown | Promise<unknown>;
};

export type BackendConfig = Omit<
  RawBackendConfig,
  'getAuthHeaders' | 'requestTransform' | 'responseTransform'
> &
  FunctionTypedBackendOverlay;

export type BackendConfigInput = Omit<
  RawBackendConfigInput,
  'getAuthHeaders' | 'requestTransform' | 'responseTransform'
> &
  FunctionTypedBackendOverlay;

type RawIAPConfig = z.infer<typeof iapConfigSchema>;
type RawIAPConfigInput = z.input<typeof iapConfigSchema>;

export type IAPConfig = Omit<RawIAPConfig, 'backend'> & { backend: BackendConfig };
export type IAPConfigInput = Omit<RawIAPConfigInput, 'backend'> & {
  backend: BackendConfigInput;
};
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type OptionsConfig = z.infer<typeof optionsConfigSchema>;
