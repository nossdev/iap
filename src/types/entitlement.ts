import { z } from 'zod';

export const entitlementBaseSchema = z.object({
  key: z.string().min(1),
  productId: z.string().min(1),
  expiresAt: z.string().nullable(),
});

/**
 * Minimum shape every entitlement returned by the backend must satisfy.
 * Consumer-defined fields pass through unvalidated unless the consumer
 * supplies their own schema via `config.backend.entitlementSchema`.
 */
export type EntitlementBase = z.infer<typeof entitlementBaseSchema>;

/** Default shape used when no `TEntitlement` type parameter is given. */
export type DefaultEntitlement = EntitlementBase;
