import { z } from 'zod';
import type { HttpRequest } from '../adapters/backend/http-client.js';
import type { LocallyVerifiedPurchase } from '../core/local-verification.js';
import { isValidUuid } from '../lib/uuid.js';
import type { EntitlementBase } from './entitlement.js';

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

/**
 * Verify purchases on the device instead of through a backend.
 *
 * For an app with no server at all. Every safety guarantee still applies —
 * the purchase flow, the acknowledge-after-verify ordering and the
 * unfinished-transaction recovery are all above the adapter boundary and do
 * not know which mode they are in. What changes is who answers "is this
 * purchase real", and how strong that answer is.
 *
 * Read `docs/guide/offline-and-no-backend.md` before choosing this: on
 * Android no cryptographic check is possible on the device, so a passing
 * verification there means "Play told this device it owns this".
 */
const verificationConfigSchema = z.object({
  mode: z.literal('local'),
  /**
   * Maps a verified purchase to the entitlements it grants. Required: iap
   * does not know what a product entitles anyone to, and in local mode
   * there is no backend to ask. Type is checked at runtime via a shape
   * guard, not zod — see {@link VerificationConfig}.
   */
  entitlements: z.unknown(),
  /**
   * The binding every purchase must carry, as passed to
   * `purchase({ appUserId })`. A purchase bound to something else is
   * refused. Omit it if the app does not bind purchases.
   *
   * Either the id itself, or a function returning it — in which case it is
   * read **at the time of each check**, so the binding follows the session.
   * A fixed string is captured at `createIAP()` time and cannot track a
   * login change, which in a multi-user app means every purchase after a
   * switch is refused as the previous user's.
   *
   * The function may return `null` for "nobody is signed in right now".
   * That is **not** the same as using no binding: iap refuses the purchase
   * rather than dropping the check. See `LocalVerificationAdapter`.
   *
   * Typed via the overlay on {@link VerificationConfig}; validated in the
   * schema's `superRefine`, the same way the backend's functions are.
   */
  appUserId: z.unknown().optional(),
});

/**
 * Android-specific settings.
 *
 * `packageName` exists because Google's verification APIs are keyed on it
 * and **the native layer does not report it**: capgo's `Transaction` shape
 * has no such field, so iap cannot derive it from a purchase. Without it,
 * every Google transaction fails to build a verify or restore request.
 *
 * Set it to your app's applicationId, exactly as Play Console has it. Only
 * required for an Android build that sells anything.
 */
const androidConfigSchema = z.object({
  packageName: z.string().min(1).optional(),
});

const storageConfigSchema = z.object({
  type: z.enum(['preferences', 'memory', 'custom']).default('preferences'),
  namespace: z.string().min(1).default('nosslabs_iap'),
  adapter: z.unknown().optional(),
});

const optionsConfigSchema = z.object({
  refreshOnResume: z.boolean().default(true),
  entitlementCacheTtlMs: z
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  /**
   * Extra time past an entitlement's `expiresAt` during which it still
   * counts as active, by the **device** clock.
   *
   * Exists because a renewal is not instantaneous: a subscription that
   * renews at midnight may not have a fresh receipt on the device for
   * minutes or hours, and locking the user out in that window is a worse
   * error than letting a lapsed subscription run slightly long. Store
   * grace periods and billing retry can stretch much further — on Android
   * those are server-side only, so a backendless app cannot see them at all
   * and this window is the only cushion it has.
   *
   * Defaults to 0: no grace, which is the strict reading of `expiresAt`.
   */
  entitlementGraceMs: z.number().int().nonnegative().default(0),
  recoverUnfinishedTransactions: z.boolean().default(true),
  /**
   * Cap on how many unfinished transactions recovery inspects per launch.
   * Defends against pathological growth if the consumer's backend has been
   * down for an extended period and the unfinished list keeps growing.
   * Excess entries stay in storage and are processed on subsequent launches.
   */
  recoveryMaxBatch: z.number().int().positive().default(50),
  /**
   * List of backend `valid:false` error codes that recovery should treat as
   * permanent — entries with a matching error are removed from storage
   * instead of retried on every launch. When omitted (the default), iap
   * uses `DEFAULT_PERMANENT_ERROR_CODES` (`['TRANSACTION_NOT_FOUND',
   * 'PRODUCT_MISMATCH']`).
   *
   * REPLACES the default when provided — pass `[...DEFAULT_PERMANENT_ERROR_CODES,
   * 'YOUR_CODE']` to extend, or `[]` to disable the feature entirely
   * (revert to retry-forever behavior). Export the constant from
   * `@nosslabs/iap` for the spread form.
   */
  permanentErrorCodes: z.array(z.string()).optional(),
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
    /**
     * The consumer's backend, which calls Attesto. Optional **only** when
     * `verification` is set instead — one of the two has to answer
     * whether a purchase is real.
     */
    backend: backendConfigSchema.optional(),
    /** On-device verification, for an app with no backend. */
    verification: verificationConfigSchema.optional(),
    /** Android-specific settings. See {@link androidConfigSchema}. */
    android: androidConfigSchema.default({}),
    storage: storageConfigSchema.default({ type: 'preferences', namespace: 'nosslabs_iap' }),
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
    // Exactly one verification source. Both would be ambiguous (which one
    // decides?) and neither leaves nothing to gate acknowledgement on.
    if (data.backend && data.verification) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Set either backend or verification, not both — they are two answers to the same question.',
        path: [],
      });
    }
    if (!data.backend && !data.verification) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'One of backend or verification is required: something has to verify a purchase before an entitlement is granted. Use verification: { mode: "local", entitlements } for an app with no backend.',
        path: [],
      });
    }
    if (data.verification && typeof data.verification.entitlements !== 'function') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'verification.entitlements must be a function ((purchase) => TEntitlement[]) — iap cannot know what a product entitles a user to.',
        path: ['verification', 'entitlements'],
      });
    }
    // Either the id or a function returning it. A non-UUID string could
    // never match a purchase — `purchase({ appUserId })` enforces the same
    // constraint — so it would silently refuse every one.
    const binding = data.verification?.appUserId;
    if (
      data.verification &&
      binding !== undefined &&
      typeof binding !== 'function' &&
      !(typeof binding === 'string' && isValidUuid(binding))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'verification.appUserId must be an RFC 9562 UUID, or a function returning one (or null when nobody is signed in) — the same constraint purchase({ appUserId }) enforces.',
        path: ['verification', 'appUserId'],
      });
    }

    // Local mode has no backend to curate a manifest, so the catalog must
    // be static. Checked here because the products rule below only knows
    // about the backend paths.
    if (data.verification && data.products === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'products is required in local verification mode: there is no backend to supply the manifest.',
        path: ['products'],
      });
    }

    if (data.products !== undefined) return;
    if (data.verification) return;
    // No static products → the backend must be able to supply them.
    // Adapter takes precedence: if `adapter` is provided, the HTTP fields are
    // ignored everywhere else, so we ignore them here too. The HTTP path is
    // only consulted when no custom adapter is set.
    // `verification` returned above, so a backend is present here.
    const backend = data.backend;
    if (!backend) return;
    const adapter = backend.adapter as { listProducts?: unknown } | undefined;
    const adapterCanList = adapter && typeof adapter.listProducts === 'function';
    const httpCanList = !backend.adapter && backend.endpoints?.products;
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

/**
 * Replace the schema's `unknown` typing for the entitlement mapper with its
 * real contract, the same way {@link BackendConfig} does for its functions.
 *
 * Generic over the consumer's entitlement shape. `LocallyVerifiedPurchase`
 * carries what a mapper needs to decide: the product, the expiry, the
 * binding, and how strongly the purchase was checked.
 */
export type VerificationConfig<TEntitlement extends EntitlementBase = EntitlementBase> = Omit<
  z.infer<typeof verificationConfigSchema>,
  'entitlements' | 'appUserId'
> & {
  entitlements: (purchase: LocallyVerifiedPurchase) => TEntitlement[];
  /**
   * The id, or a getter so the binding can follow the session. A getter
   * returning `null` means "nobody signed in", and refuses rather than
   * skipping the check.
   */
  appUserId?: string | (() => string | null);
};

export type IAPConfig<TEntitlement extends EntitlementBase = EntitlementBase> = Omit<
  RawIAPConfig,
  'backend' | 'verification'
> & {
  backend?: BackendConfig;
  verification?: VerificationConfig<TEntitlement>;
};

export type IAPConfigInput<TEntitlement extends EntitlementBase = EntitlementBase> = Omit<
  RawIAPConfigInput,
  'backend' | 'verification'
> & {
  backend?: BackendConfigInput;
  verification?: VerificationConfig<TEntitlement>;
};
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type OptionsConfig = z.infer<typeof optionsConfigSchema>;
