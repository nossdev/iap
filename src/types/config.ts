import { z } from 'zod';

export const productTypeSchema = z.enum(['subscription', 'product', 'consumable']);

export const configuredProductSchema = z
  .object({
    id: z.string().min(1),
    type: productTypeSchema,
    androidPlanId: z.string().min(1).optional(),
  })
  .refine((p) => p.type !== 'subscription' || !!p.androidPlanId, {
    message: 'androidPlanId is required for subscription products (used by Android Play Billing).',
    path: ['androidPlanId'],
  });

export const backendEndpointsSchema = z.object({
  verifyApple: z.string().min(1),
  verifyGoogle: z.string().min(1),
  entitlements: z.string().min(1),
  restore: z.string().min(1),
});

export const backendConfigSchema = z
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
    getAuthHeaders: z
      .function()
      .args()
      .returns(z.union([z.record(z.string()), z.promise(z.record(z.string()))]))
      .optional(),
    requestTransform: z.function().optional(),
    responseTransform: z.function().optional(),
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
    if (!data.getAuthHeaders) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'backend.getAuthHeaders is required when no custom adapter is provided.',
        path: ['getAuthHeaders'],
      });
    }
  });

export const storageConfigSchema = z.object({
  type: z.enum(['preferences', 'memory', 'custom']).default('preferences'),
  namespace: z.string().min(1).default('nossdev_iap'),
  adapter: z.unknown().optional(),
});

export const optionsConfigSchema = z.object({
  refreshOnResume: z.boolean().default(true),
  entitlementCacheTtlMs: z
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  recoverUnfinishedTransactions: z.boolean().default(true),
  productPriceCacheTtlMs: z
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
  logger: z.unknown().optional(),
});

export const iapConfigSchema = z.object({
  products: z.array(configuredProductSchema).min(1),
  backend: backendConfigSchema,
  storage: storageConfigSchema.default({ type: 'preferences', namespace: 'nossdev_iap' }),
  options: optionsConfigSchema.default({
    refreshOnResume: true,
    entitlementCacheTtlMs: 60 * 60 * 1000,
    recoverUnfinishedTransactions: true,
    productPriceCacheTtlMs: 24 * 60 * 60 * 1000,
    logLevel: 'info',
  }),
});

export type IAPConfig = z.infer<typeof iapConfigSchema>;
export type IAPConfigInput = z.input<typeof iapConfigSchema>;
export type BackendConfig = z.infer<typeof backendConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type OptionsConfig = z.infer<typeof optionsConfigSchema>;
