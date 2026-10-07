// Unified loadtest.config.json schema — normative spec is loadtest/DESIGN.md
// §2 (§2.1 field reference, §2.2 secrets-as-refs, §2.3/§2.4 worked examples).
// Style-matched to config/configSchema.mjs + config/configValidator.mjs: a
// zod object for structure, plus a superRefine pass for the cross-field
// checks that a single field's type can't express, each error message
// prefixed with the named code from DESIGN §2.1's table so `validate`'s
// output — and every negative test in schema.test.ts — can key off it.
//
// Two things DESIGN §2 attributes specifically to the `validate` CLI command
// rather than to "the schema" are deliberately NOT enforced here:
// `PROXY_URL_PLACEHOLDER` (§2.4) and `RING_MUST_START_AT_ASSET_ORIGIN` (§3.7).
// Both are exposed instead as `checkOperationalConstraints`, called by
// `cli.ts`'s `validate` command. This split exists because the shipped
// `config/examples/testnet.loadtest.json` intentionally ships an
// unreplaced `REPLACE-ME` placeholder host (the operator must supply the
// real proxy URL) — if that check lived inside `loadtestConfigSchema`,
// `schema.parse` would throw on that example and the round-trip test
// (`schema.parse(serialize(schema.parse(x))) deepEquals schema.parse(x)`,
// DESIGN §2's operational definition) could never run against it.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives (mirrors config/configSchema.mjs's isHttpUrl / addressString)
// ---------------------------------------------------------------------------

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const urlString = z
  .string()
  .url()
  .refine(isHttpUrl, { message: 'must use the http or https scheme' });

const addressString = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte address');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const nonZeroAddressString = addressString.refine((value) => value.toLowerCase() !== ZERO_ADDRESS, {
  message: 'must be non-zero'
});

// DESIGN §2.1: `chains[].key` matches ^[A-Z0-9_]+$; `ring[]` entries and
// `autoclaim` hop labels are built from the same charset.
const chainKeyString = z.string().regex(/^[A-Z0-9_]+$/, 'must match ^[A-Z0-9_]+$');

const autoclaimHopKeyString = z
  .string()
  .regex(/^[A-Z0-9_]+->[A-Z0-9_]+$/, 'must match "<FROM>-><TO>" using chain keys');

const nonNegativeDecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');

const positiveDecimalString = nonNegativeDecimalString.refine((value) => Number(value) > 0, {
  message: 'must be greater than 0'
});

// DESIGN §2.2: a private key is always a `secretRef`, never inline.
export const secretRefSchema = z.union([
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ file: z.string().min(1) }).strict()
]);

export type SecretRef = z.infer<typeof secretRefSchema>;

// ---------------------------------------------------------------------------
// chains[]
// ---------------------------------------------------------------------------

export const chainSchema = z
  .object({
    key: chainKeyString,
    chainId: z.number().int().positive(),
    networkId: z.number().int().min(0),
    rpcUrl: urlString,
    bridgeAddress: nonZeroAddressString,
    explorerUrl: z.string().default(''),
    nativeSymbol: z.string().default('ETH')
  })
  .strict();

export type LoadtestChain = z.infer<typeof chainSchema>;

// ---------------------------------------------------------------------------
// autoclaim
// ---------------------------------------------------------------------------

export const autoclaimEntrySchema = z
  .object({
    expected: z.boolean(),
    waitMs: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expected && value.waitMs === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['waitMs'],
        message: 'AUTOCLAIM_WAIT_REQUIRED: waitMs is required when expected is true'
      });
    }
  });

export type AutoclaimEntry = z.infer<typeof autoclaimEntrySchema>;

// ---------------------------------------------------------------------------
// assets[]
// ---------------------------------------------------------------------------

const assetBaseSchema = z
  .object({
    kind: z.enum(['eth', 'erc20']),
    address: nonZeroAddressString.optional(),
    originNetworkId: z.number().int().min(0).optional(),
    amount: positiveDecimalString,
    decimals: z.number().int().min(0).max(36).default(18)
  })
  .strict();

export const assetSchema = assetBaseSchema.superRefine((value, ctx) => {
  if (value.kind === 'erc20') {
    if (value.address === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['address'],
        message: 'ASSET_ERC20_ADDRESS_REQUIRED: erc20 assets require an address'
      });
    }
    if (value.originNetworkId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['originNetworkId'],
        message: 'ASSET_ERC20_ORIGIN_REQUIRED: erc20 assets require originNetworkId'
      });
    }
  } else {
    if (value.address !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['address'],
        message: 'ASSET_ETH_ADDRESS_FORBIDDEN: eth assets must not set address'
      });
    }
    if (value.originNetworkId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['originNetworkId'],
        message: 'ASSET_ETH_ORIGIN_FORBIDDEN: eth assets must not set originNetworkId'
      });
    }
  }
});

export type LoadtestAsset = z.infer<typeof assetSchema>;

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

const walletsSchema = z.union([
  z.object({ mnemonicRef: secretRefSchema, startIndex: z.number().int().min(0) }).strict(),
  z.object({ privateKeysRef: secretRefSchema }).strict()
]);

const funderSchema = z
  .object({
    privateKeyRef: secretRefSchema,
    gasPerChain: z.record(chainKeyString, nonNegativeDecimalString),
    // DESIGN §2.1's documented default (`assets[i].amount × 4`) is per-asset,
    // so it can't be expressed as a single static zod default at this level
    // — it is applied by the funding logic (S05), not here.
    assetTopUp: nonNegativeDecimalString.optional(),
    maxTotalSpend: z.record(chainKeyString, nonNegativeDecimalString),
    // R19 (loadtest/REVIEW.md): `maxTotalSpend` caps native currency only —
    // ERC20 top-ups had NO cap of any kind on the testnet/mainnet transfer
    // path. Denominated in each erc20 asset's own decimal units, applied
    // uniformly across every erc20 asset (mirroring `assetTopUp`'s own
    // single-scalar-across-assets shape, S05 outcome). Required whenever a
    // non-devnet fund uses an erc20 asset — see `crossFieldValidation`'s
    // `FUNDER_MAX_ERC20_SPEND_REQUIRED` below — so an operator cannot ship a
    // testnet/mainnet config with an uncapped ERC20 spend by omission.
    maxTotalErc20Spend: nonNegativeDecimalString.optional()
  })
  .strict();

export type LoadtestFunder = z.infer<typeof funderSchema>;

const usersSchema = z
  .object({
    total: z.number().int().min(1),
    browser: z.number().int().min(0),
    wallets: walletsSchema,
    funder: funderSchema.optional(),
    devnetFunding: z.enum(['anvil_setBalance', 'transfer']).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.browser > value.total) {
      ctx.addIssue({
        code: 'custom',
        path: ['browser'],
        message: 'USERS_BROWSER_EXCEEDS_TOTAL: users.browser must be <= users.total'
      });
    }
  });

export type LoadtestUsers = z.infer<typeof usersSchema>;

// ---------------------------------------------------------------------------
// load / browser / timeouts / gas / output
// ---------------------------------------------------------------------------

const loadSchema = z
  .object({
    bridgesPerMinutePerUser: z.number().positive(),
    durationMinutes: z.number().positive(),
    rampUpSeconds: z.number().int().min(0).default(60),
    maxInflightLapsPerUser: z.number().int().min(1).default(3)
  })
  .strict()
  .superRefine((value, ctx) => {
    // R9 (loadtest/REVIEW.md): with no guard, `rampUpSeconds >=
    // durationMinutes * 60` silently produces a `steadyStateRatePerUserPerMin`
    // of exactly 0.0000 in the report (there is no steady-state window at
    // all) with no warning anywhere — `--minutes 1` at the default 60s ramp
    // is a perfectly plausible smoke invocation and hits this immediately.
    if (value.rampUpSeconds >= value.durationMinutes * 60) {
      ctx.addIssue({
        code: 'custom',
        path: ['rampUpSeconds'],
        message:
          'RAMP_UP_EXCEEDS_DURATION: load.rampUpSeconds must be less than load.durationMinutes * 60, or the run has no steady-state window and reports an undefined (0.0000) achieved rate'
      });
    }
  });

// zod v4 types `.default()` on an object schema against its OUTPUT shape
// (post-inner-defaults), not a partial input — so each wrapper below passes
// its default as a fully-resolved literal (or, for `output`, a function
// returning one) rather than relying on `{}` to cascade through the inner
// per-field defaults a second time. The values still match DESIGN §2.1/§3.3
// exactly; only the mechanism differs from a naive `{}`.
// S16/A3 (VALIDATION-1.md): `contextsPerBrowser: 25` with 20 browser users
// gave `slotCount = ceil(20/25) = 1` — every browser user ran in ONE
// Chromium process, so a single crash took out all of them (226
// `browser_crash` from 20 users, in bursts of 40/46/58/27). The max is
// lowered from 25 to 8 so `ceil(users.browser / contextsPerBrowser) >=
// ceil(users.browser / 8)` holds for every schema-valid config — i.e. no
// browser crash can ever take out more than 8 users at once, regardless of
// `users.browser`.
const browserSchema = z
  .object({
    contextsPerBrowser: z.number().int().min(1).max(8).default(8),
    headless: z.boolean().default(true),
    trace: z.boolean().default(false),
    recycleContextAfterLaps: z.number().int().min(1).default(10)
  })
  .strict()
  .default({ contextsPerBrowser: 8, headless: true, trace: false, recycleContextAfterLaps: 10 });

// DESIGN §3.3's devnet timeout defaults.
const timeoutsSchema = z
  .object({
    txReceiptMs: z.number().int().positive().default(60_000),
    appearsInActivityMs: z.number().int().positive().default(60_000),
    readyToClaimMs: z.number().int().positive().default(600_000),
    claimedMs: z.number().int().positive().default(600_000),
    hopMs: z.number().int().positive().default(900_000),
    lapMs: z.number().int().positive().default(2_700_000),
    pageLoadMs: z.number().int().positive().default(30_000),
    walletConnectMs: z.number().int().positive().default(15_000)
  })
  .strict()
  .default({
    txReceiptMs: 60_000,
    appearsInActivityMs: 60_000,
    readyToClaimMs: 600_000,
    claimedMs: 600_000,
    hopMs: 900_000,
    lapMs: 2_700_000,
    pageLoadMs: 30_000,
    walletConnectMs: 15_000
  });

const gasSchema = z
  .object({
    bridgeGasOffset: z.number().int().min(0).default(300_000)
  })
  .strict()
  .default({ bridgeGasOffset: 300_000 });

// `YYYYMMDDTHHMMSSZ` — DESIGN §2.1's "ISO-8601 basic timestamp".
const isoBasicTimestamp = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

const outputSchema = z
  .object({
    dir: z
      .string()
      .min(1)
      .default(() => `loadtest-results/${isoBasicTimestamp()}`),
    activityLog: z.boolean().default(true)
  })
  .strict()
  .default(() => ({ dir: `loadtest-results/${isoBasicTimestamp()}`, activityLog: true }));

// ---------------------------------------------------------------------------
// Top-level object + cross-field validation
// ---------------------------------------------------------------------------

const rawConfigSchema = z
  .object({
    env: z.enum(['devnet', 'testnet', 'mainnet']),
    uiBaseUrl: urlString.optional(),
    aggkitProxyUrl: urlString,
    chains: z.array(chainSchema).min(2),
    ring: z.array(chainKeyString),
    autoclaim: z.record(autoclaimHopKeyString, autoclaimEntrySchema),
    assets: z.array(assetSchema).min(1),
    users: usersSchema,
    load: loadSchema,
    browser: browserSchema,
    timeouts: timeoutsSchema,
    gas: gasSchema,
    output: outputSchema
  })
  .strict();

type RawLoadtestConfig = z.infer<typeof rawConfigSchema>;

const PRIVATE_KEY_LITERAL_PATTERN = /^0x[0-9a-fA-F]{64}$/;

interface InlinePrivateKeyHit {
  path: (string | number)[];
}

// DESIGN §2.2: a private key literal is forbidden ANYWHERE in the document,
// not just in the fields that happen to be typed as secretRef — walk the
// whole parsed value.
const findInlinePrivateKeys = (
  value: unknown,
  path: (string | number)[] = []
): InlinePrivateKeyHit[] => {
  if (typeof value === 'string') {
    return PRIVATE_KEY_LITERAL_PATTERN.test(value) ? [{ path }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findInlinePrivateKeys(item, [...path, index]));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      findInlinePrivateKeys(item, [...path, key])
    );
  }
  return [];
};

const formatHopLabel = (fromKey: string, toKey: string): string => `${fromKey}->${toKey}`;

const getRingHops = (ring: string[]): string[] => {
  const hops: string[] = [];
  for (let index = 0; index < ring.length - 1; index += 1) {
    hops.push(formatHopLabel(ring[index], ring[index + 1]));
  }
  return hops;
};

const crossFieldValidation = (value: RawLoadtestConfig, ctx: z.RefinementCtx): void => {
  const addIssue = (code: string, message: string, path: (string | number)[] = []): void => {
    ctx.addIssue({ code: 'custom', path, message: `${code}: ${message}` });
  };

  // --- ring shape -----------------------------------------------------
  const { ring } = value;
  const chainKeys = new Set(value.chains.map((chain) => chain.key));

  if (ring.length < 3) {
    addIssue('RING_TOO_SHORT', 'ring must have at least 3 entries (a closed ring of >=2 hops)', [
      'ring'
    ]);
  } else {
    if (ring[0] !== ring[ring.length - 1]) {
      addIssue(
        'RING_NOT_CLOSED',
        `ring must start and end at the same chain key (starts "${ring[0]}", ends "${ring[ring.length - 1]}")`,
        ['ring']
      );
    }
    for (let index = 0; index < ring.length - 1; index += 1) {
      if (ring[index] === ring[index + 1]) {
        addIssue(
          'RING_TOO_SHORT',
          `ring[${index}] and ring[${index + 1}] are both "${ring[index]}" — consecutive ring entries must be distinct`,
          ['ring', index]
        );
      }
    }
  }

  ring.forEach((key, index) => {
    if (!chainKeys.has(key)) {
      addIssue('RING_UNKNOWN_CHAIN', `ring[${index}] = "${key}" is not present in chains`, [
        'ring',
        index
      ]);
    }
  });

  // --- chains[] uniqueness ---------------------------------------------
  const seenChainKey = new Map<string, number>();
  const seenChainId = new Map<number, string>();
  const seenNetworkId = new Map<number, string>();

  value.chains.forEach((chain, index) => {
    const existingKeyIndex = seenChainKey.get(chain.key);
    if (existingKeyIndex !== undefined) {
      addIssue(
        'CHAIN_KEY_DUPLICATE',
        `chains[${index}].key "${chain.key}" duplicates chains[${existingKeyIndex}]`,
        ['chains', index, 'key']
      );
    } else {
      seenChainKey.set(chain.key, index);
    }

    const existingChainIdKey = seenChainId.get(chain.chainId);
    if (existingChainIdKey !== undefined) {
      addIssue(
        'CHAIN_ID_DUPLICATE',
        `chains[${index}].chainId ${chain.chainId} duplicates chain "${existingChainIdKey}"`,
        ['chains', index, 'chainId']
      );
    } else {
      seenChainId.set(chain.chainId, chain.key);
    }

    const existingNetworkIdKey = seenNetworkId.get(chain.networkId);
    if (existingNetworkIdKey !== undefined) {
      addIssue(
        'CHAIN_ID_DUPLICATE',
        `chains[${index}].networkId ${chain.networkId} duplicates chain "${existingNetworkIdKey}"`,
        ['chains', index, 'networkId']
      );
    } else {
      seenNetworkId.set(chain.networkId, chain.key);
    }
  });

  // --- exactly one L1 (networkId 0) -------------------------------------
  const l1ChainCount = value.chains.filter((chain) => chain.networkId === 0).length;
  if (l1ChainCount !== 1) {
    addIssue(
      'L1_CHAIN_AMBIGUOUS',
      `exactly one chain must have networkId 0; found ${l1ChainCount}`,
      ['chains']
    );
  }

  // --- autoclaim <-> ring hops -------------------------------------------
  if (ring.length >= 3) {
    const hops = getRingHops(ring);
    const hopSet = new Set(hops);

    hops.forEach((hop) => {
      if (!(hop in value.autoclaim)) {
        addIssue('AUTOCLAIM_HOP_MISSING', `autoclaim is missing an entry for ring hop "${hop}"`, [
          'autoclaim'
        ]);
      }
    });

    Object.keys(value.autoclaim).forEach((key) => {
      if (!hopSet.has(key)) {
        addIssue('AUTOCLAIM_HOP_UNKNOWN', `autoclaim entry "${key}" is not a hop of ring`, [
          'autoclaim',
          key
        ]);
      }
    });
  }

  // --- uiBaseUrl required when any user is a browser user ---------------
  if (value.users.browser > 0 && value.uiBaseUrl === undefined) {
    addIssue('UI_BASE_URL_REQUIRED', 'uiBaseUrl is required when users.browser > 0', ['uiBaseUrl']);
  }

  // --- devnetFunding only meaningful on env === 'devnet' -----------------
  if (value.env !== 'devnet' && value.users.devnetFunding !== undefined) {
    addIssue(
      'DEVNET_FUNDING_NOT_ALLOWED',
      `users.devnetFunding may only be set when env is "devnet" (env is "${value.env}")`,
      ['users', 'devnetFunding']
    );
  }

  // --- funder required unless devnet + anvil_setBalance -------------------
  const effectiveDevnetFunding =
    value.env === 'devnet' ? (value.users.devnetFunding ?? 'anvil_setBalance') : undefined;
  const funderRequired = !(value.env === 'devnet' && effectiveDevnetFunding === 'anvil_setBalance');
  if (funderRequired && value.users.funder === undefined) {
    addIssue(
      'FUNDER_REQUIRED',
      'users.funder is required unless env is "devnet" with devnetFunding "anvil_setBalance"',
      ['users', 'funder']
    );
  }

  // --- funder must cover every ring chain --------------------------------
  if (value.users.funder !== undefined && ring.length >= 3) {
    const ringChainKeys = new Set(ring.slice(0, -1));
    ringChainKeys.forEach((key) => {
      if (!(key in value.users.funder!.gasPerChain)) {
        addIssue(
          'FUNDER_GAS_PER_CHAIN_MISSING',
          `users.funder.gasPerChain is missing an entry for ring chain "${key}"`,
          ['users', 'funder', 'gasPerChain']
        );
      }
      if (!(key in value.users.funder!.maxTotalSpend)) {
        addIssue(
          'FUNDER_MAX_TOTAL_SPEND_MISSING',
          `users.funder.maxTotalSpend is missing an entry for ring chain "${key}"`,
          ['users', 'funder', 'maxTotalSpend']
        );
      }
    });
  }

  // --- R19: ERC20 top-ups must be capped whenever a funder is required ---
  // (`funderRequired` is the same flag `FUNDER_REQUIRED` above uses — devnet
  // + anvil_setBalance is the one case where funding is "free" and an
  // uncapped ERC20 mint carries no real-funds risk).
  const hasErc20Asset = value.assets.some((asset) => asset.kind === 'erc20');
  if (
    funderRequired &&
    hasErc20Asset &&
    value.users.funder !== undefined &&
    value.users.funder.maxTotalErc20Spend === undefined
  ) {
    addIssue(
      'FUNDER_MAX_ERC20_SPEND_REQUIRED',
      'users.funder.maxTotalErc20Spend is required when a non-devnet-anvil fund uses an erc20 asset — ERC20 top-ups would otherwise be uncapped',
      ['users', 'funder', 'maxTotalErc20Spend']
    );
  }

  // --- R23: nothing else cross-checks the `env` label against the actual
  //     chains — it drives real safety decisions (the anvil_setBalance
  //     gate, R0's mainnet confirmation, the funding strategy) but was
  //     otherwise untrusted free-standing input. Two cheap, registry-free
  //     checks: (1) `env: "devnet"` must point at loopback RPCs (this repo's
  //     devnet always runs on 127.0.0.1/localhost through haproxy — a
  //     `devnet`-labelled config naming a real remote RPC is almost
  //     certainly a mislabelled testnet/mainnet config); (2) the L1 chain's
  //     `chainId` must be Ethereum mainnet (1) if and only if `env` is
  //     "mainnet" — this tool's ring always starts/ends on L1, so this one
  //     well-known id is enough to catch "devnet config relabelled
  //     mainnet" and "mainnet config still pointing at a testnet L1" without
  //     a maintained registry of every possible chain id. ------------------
  const isLoopbackRpc = (rpcUrl: string): boolean => {
    try {
      const { hostname } = new URL(rpcUrl);
      return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
    } catch {
      return false;
    }
  };

  if (value.env === 'devnet') {
    value.chains.forEach((chain, index) => {
      if (!isLoopbackRpc(chain.rpcUrl)) {
        addIssue(
          'ENV_RPC_URL_MISMATCH',
          `chains[${index}].rpcUrl "${chain.rpcUrl}" is not a loopback address, but env is "devnet" — this repo's devnet always runs on 127.0.0.1/localhost; a non-loopback RPC here almost always means env is mislabelled`,
          ['chains', index, 'rpcUrl']
        );
      }
    });
  }

  const ETHEREUM_MAINNET_CHAIN_ID = 1;
  const l1Chain = value.chains.find((chain) => chain.networkId === 0);
  if (l1Chain !== undefined) {
    const l1IsMainnet = l1Chain.chainId === ETHEREUM_MAINNET_CHAIN_ID;
    if (value.env === 'mainnet' && !l1IsMainnet) {
      addIssue(
        'ENV_CHAIN_ID_MISMATCH',
        `env is "mainnet" but the L1 chain ("${l1Chain.key}") has chainId ${l1Chain.chainId}, not Ethereum mainnet's ${ETHEREUM_MAINNET_CHAIN_ID}`,
        ['chains']
      );
    }
    if (value.env !== 'mainnet' && l1IsMainnet) {
      addIssue(
        'ENV_CHAIN_ID_MISMATCH',
        `env is "${value.env}" but the L1 chain ("${l1Chain.key}") has chainId ${ETHEREUM_MAINNET_CHAIN_ID} (Ethereum mainnet) — this would skip R0's mainnet confirmation gate on real mainnet chain ids`,
        ['chains']
      );
    }
  }

  // --- assets[] semantics -------------------------------------------------
  const seenErc20Address = new Map<string, number>();
  let ethAssetCount = 0;
  value.assets.forEach((asset, index) => {
    if (asset.kind === 'eth') {
      ethAssetCount += 1;
    }
    if (asset.kind === 'erc20' && asset.address !== undefined) {
      const normalized = asset.address.toLowerCase();
      const existingIndex = seenErc20Address.get(normalized);
      if (existingIndex !== undefined) {
        addIssue(
          'ASSET_ERC20_ADDRESS_DUPLICATE',
          `assets[${index}].address duplicates assets[${existingIndex}]`,
          ['assets', index, 'address']
        );
      } else {
        seenErc20Address.set(normalized, index);
      }
    }
    if (asset.kind === 'erc20' && asset.originNetworkId !== undefined) {
      const matchesKnownChain = value.chains.some(
        (chain) => chain.networkId === asset.originNetworkId
      );
      if (!matchesKnownChain) {
        addIssue(
          'ASSET_ORIGIN_NETWORK_UNKNOWN',
          `assets[${index}].originNetworkId ${asset.originNetworkId} does not match any chains[].networkId`,
          ['assets', index, 'originNetworkId']
        );
      }
    }
  });
  if (ethAssetCount > 1) {
    addIssue('ASSET_ETH_DUPLICATE', 'at most one asset with kind "eth" is allowed', ['assets']);
  }

  // --- aggkitProxyUrl shape -------------------------------------------------
  if (value.aggkitProxyUrl.endsWith('/')) {
    addIssue(
      'AGGKIT_PROXY_URL_TRAILING_SLASH',
      'aggkitProxyUrl must not end with a trailing slash',
      ['aggkitProxyUrl']
    );
  }
  if (value.aggkitProxyUrl.endsWith('/bridge/v1') || value.aggkitProxyUrl.endsWith('/tracker/v1')) {
    addIssue(
      'AGGKIT_PROXY_URL_SUFFIX_FORBIDDEN',
      'aggkitProxyUrl must not end in /bridge/v1 or /tracker/v1 — the SDK and fetchActivity append those',
      ['aggkitProxyUrl']
    );
  }

  // --- inline private key literals, anywhere in the document -------------
  findInlinePrivateKeys(value).forEach((hit) => {
    addIssue(
      'INLINE_PRIVATE_KEY_FORBIDDEN',
      `a 32-byte hex literal was found at "${hit.path.join('.')}" — private keys must be provided via a secretRef ({env} or {file}), never inline`,
      hit.path
    );
  });
};

export const loadtestConfigSchema = rawConfigSchema.superRefine(crossFieldValidation);

export type LoadtestConfig = z.infer<typeof loadtestConfigSchema>;

// ---------------------------------------------------------------------------
// Parsing / serialization / operational (validate-only) checks
// ---------------------------------------------------------------------------

export class LoadtestConfigError extends Error {}

const formatIssuePath = (path: (string | number | symbol)[]): string => {
  if (path.length === 0) return 'config';
  return path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : String(segment)))
    .join('.');
};

export const parseLoadtestConfig = (json: unknown): LoadtestConfig => {
  const result = loadtestConfigSchema.safeParse(json);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${formatIssuePath(issue.path)}: ${issue.message}`
    );
    throw new LoadtestConfigError(
      `loadtest config validation failed:\n${lines.map((line) => `- ${line}`).join('\n')}`
    );
  }
  return result.data;
};

// DESIGN §2's round-trip operational definition uses exactly this
// serialization: `JSON.stringify(value, null, 2)`.
export const serializeLoadtestConfig = (config: LoadtestConfig): string =>
  JSON.stringify(config, null, 2);

const PLACEHOLDER_HOST_NEEDLES = ['PLACEHOLDER', 'REPLACE-ME'];

// Checks attributed to the `validate` CLI command rather than to the schema
// itself — see the file-header comment for why (`config/examples/testnet.
// loadtest.json` must still round-trip through `loadtestConfigSchema` while
// legitimately failing these two).
export const checkOperationalConstraints = (config: LoadtestConfig): string[] => {
  const issues: string[] = [];

  const upperProxyUrl = config.aggkitProxyUrl.toUpperCase();
  if (PLACEHOLDER_HOST_NEEDLES.some((needle) => upperProxyUrl.includes(needle))) {
    issues.push(
      `PROXY_URL_PLACEHOLDER: aggkitProxyUrl "${config.aggkitProxyUrl}" is a placeholder — the operator must supply the real aggkit-proxy URL for this environment`
    );
  }

  const ringStartKey = config.ring[0];
  const ringStartChain = config.chains.find((chain) => chain.key === ringStartKey);
  if (ringStartChain !== undefined) {
    config.assets.forEach((asset) => {
      if (
        asset.kind === 'erc20' &&
        asset.originNetworkId !== undefined &&
        asset.originNetworkId !== ringStartChain.networkId
      ) {
        issues.push(
          `RING_MUST_START_AT_ASSET_ORIGIN: ring[0] ("${ringStartKey}", networkId ${ringStartChain.networkId}) must be the origin chain (networkId ${asset.originNetworkId}) of erc20 asset "${asset.address}"`
        );
      }
    });
  }

  return issues;
};
