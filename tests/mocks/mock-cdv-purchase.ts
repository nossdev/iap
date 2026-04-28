/**
 * Minimal in-memory mock of `globalThis.CdvPurchase` for unit tests.
 * Exposes just enough surface area for `CdvNativeAdapter` to work without
 * the real cordova bridge.
 */

type ApprovedHandler = (tx: MockTransaction) => void;

export interface MockTransaction {
  platform: 'ios-appstore' | 'android-playstore';
  transactionId: string;
  state: string;
  products: Array<{ id: string; offerId?: string }>;
  finishCalls: number;
  finish: () => Promise<void>;
  // Google extras (optional)
  nativePurchase?: { purchaseToken: string };
}

export interface MockOffer {
  order: () => Promise<MockError | undefined>;
  pricingPhases: Array<{ price: string; priceMicros: number; currency: string }>;
}

export interface MockProduct {
  id: string;
  title: string;
  description: string;
  getOffer: () => MockOffer | undefined;
}

export interface MockError {
  isError: true;
  code: number;
  message: string;
}

export interface MockStore {
  // exposed for tests to drive
  _registered: Array<{ id: string; type: string; platform: string }>;
  _initialized: boolean;
  _approvedHandlers: ApprovedHandler[];
  _localTransactions: MockTransaction[];
  _products: Map<string, MockProduct>;
  _orderImpl: (productId: string) => Promise<MockError | undefined>;
  _restoreImpl: () => Promise<MockError | undefined>;

  // public surface used by the adapter
  register: (
    products:
      | { id: string; type: string; platform: string }
      | Array<{ id: string; type: string; platform: string }>,
  ) => void;
  initialize: (platforms: unknown[]) => Promise<MockError[]>;
  update: () => Promise<void>;
  get: (id: string) => MockProduct | undefined;
  when: () => { approved: (cb: ApprovedHandler) => unknown };
  off: (cb: ApprovedHandler) => void;
  order: (offer: MockOffer) => Promise<MockError | undefined>;
  restorePurchases: () => Promise<MockError | undefined>;
  manageSubscriptions: () => Promise<MockError | undefined>;
  get localTransactions(): MockTransaction[];
}

export interface MockCdv {
  store: MockStore;
  Platform: { APPLE_APPSTORE: 'ios-appstore'; GOOGLE_PLAY: 'android-playstore' };
  ProductType: {
    PAID_SUBSCRIPTION: 'paid subscription';
    NON_CONSUMABLE: 'non consumable';
    CONSUMABLE: 'consumable';
  };
  ErrorCode: { PAYMENT_CANCELLED: number };
  TransactionState: {
    INITIATED: 'initiated';
    PENDING: 'pending';
    APPROVED: 'approved';
    CANCELLED: 'cancelled';
    FINISHED: 'finished';
  };
}

const PAYMENT_CANCELLED_CODE = 6777006;

export interface InstallOptions {
  products?: Array<{
    id: string;
    title?: string;
    description?: string;
    priceString?: string;
    priceMicros?: number;
    currency?: string;
  }>;
  defaultPlatform?: 'ios-appstore' | 'android-playstore';
}

export function installMockCdv(opts: InstallOptions = {}): MockCdv {
  const platform = opts.defaultPlatform ?? 'ios-appstore';
  const productMap = new Map<string, MockProduct>();
  for (const cfg of opts.products ?? []) {
    const phase = {
      price: cfg.priceString ?? '$0.00',
      priceMicros: cfg.priceMicros ?? 0,
      currency: cfg.currency ?? 'USD',
    };
    const offer: MockOffer = {
      pricingPhases: [phase],
      order: async () => store._orderImpl(cfg.id),
    };
    productMap.set(cfg.id, {
      id: cfg.id,
      title: cfg.title ?? cfg.id,
      description: cfg.description ?? '',
      getOffer: () => offer,
    });
  }

  const store: MockStore = {
    _registered: [],
    _initialized: false,
    _approvedHandlers: [],
    _localTransactions: [],
    _products: productMap,
    _orderImpl: async () => undefined,
    _restoreImpl: async () => undefined,

    register(products) {
      const arr = Array.isArray(products) ? products : [products];
      for (const p of arr) store._registered.push(p);
    },
    async initialize() {
      store._initialized = true;
      return [];
    },
    async update() {
      // no-op
    },
    get(id) {
      return store._products.get(id);
    },
    when() {
      return {
        approved(cb: ApprovedHandler) {
          store._approvedHandlers.push(cb);
          return { approved: () => ({}) };
        },
      };
    },
    off(cb: ApprovedHandler) {
      const idx = store._approvedHandlers.indexOf(cb);
      if (idx >= 0) store._approvedHandlers.splice(idx, 1);
    },
    async order(offer) {
      return offer.order();
    },
    async restorePurchases() {
      return store._restoreImpl();
    },
    async manageSubscriptions() {
      return undefined;
    },
    get localTransactions() {
      return store._localTransactions;
    },
  };

  const mock: MockCdv = {
    store,
    Platform: {
      APPLE_APPSTORE: 'ios-appstore',
      GOOGLE_PLAY: 'android-playstore',
    },
    ProductType: {
      PAID_SUBSCRIPTION: 'paid subscription',
      NON_CONSUMABLE: 'non consumable',
      CONSUMABLE: 'consumable',
    },
    ErrorCode: { PAYMENT_CANCELLED: PAYMENT_CANCELLED_CODE },
    TransactionState: {
      INITIATED: 'initiated',
      PENDING: 'pending',
      APPROVED: 'approved',
      CANCELLED: 'cancelled',
      FINISHED: 'finished',
    },
  };

  (globalThis as { CdvPurchase?: unknown; navigator?: { userAgent: string } }).CdvPurchase = mock;
  if (typeof navigator === 'undefined' || !('userAgent' in navigator)) {
    (globalThis as { navigator?: { userAgent: string } }).navigator = {
      userAgent: platform === 'ios-appstore' ? 'iPhone' : 'Android',
    };
  }

  return mock;
}

export function uninstallMockCdv(): void {
  (globalThis as { CdvPurchase?: unknown }).CdvPurchase = undefined;
}

export function fireApproved(mock: MockCdv, tx: MockTransaction): void {
  for (const cb of [...mock.store._approvedHandlers]) cb(tx);
}

export function makeTransaction(
  productId: string,
  overrides: Partial<MockTransaction> = {},
): MockTransaction {
  let finishCalls = 0;
  const tx: MockTransaction = {
    platform: 'ios-appstore',
    transactionId: `txn-${productId}-${Date.now()}`,
    state: 'approved',
    products: [{ id: productId }],
    finishCalls: 0,
    finish: async () => {
      finishCalls += 1;
      tx.finishCalls = finishCalls;
    },
    ...overrides,
  };
  return tx;
}

export const MOCK_PAYMENT_CANCELLED_CODE = PAYMENT_CANCELLED_CODE;
