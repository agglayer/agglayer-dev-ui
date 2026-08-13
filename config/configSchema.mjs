import { z } from 'zod';

import { APP_MODES } from './appModes.mjs';

const modeEnum = z.enum(APP_MODES);
const nonEmptyString = z.string().trim().min(1);
// Every absolute URL in config.json must be http(s). zod's `.url()` only
// requires that the value parse as a URL, so on its own it accepts
// `javascript:...`, `data:...`, `file:...` and any other scheme. config.json is
// mounted at container start (see entrypoint.sh / docs/docker.md), so it is an
// untrusted input wherever someone other than the app owner can supply it, and
// several of these values reach navigation sinks unmodified — `externalLinks.*`
// and `explorerUrl` land in `<a href>` (app/components/header/constants.ts,
// bridgeSuccessView.tsx, claimResultModal.tsx) and in
// `window.open(...)` (app/components/transactions/transactionListItem.tsx:126,
// transactionDetailsModal.tsx:107,139, bridge/tokenSelectorManageView.tsx:168).
// A `javascript:` value there executes with the app's origin. Constrain the
// scheme here, at the single choke point every loader shares
// (config/configLoader.mjs's normalizeConfigOrThrow), rather than at each sink.
const isHttpUrl = (value) => {
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
const optionalUrlString = z.union([urlString, z.literal('')]);
const addressString = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
// JSON object keys are always strings; network ids are validated as digit strings
// so they can be parsed to number when the aggregator config is built (app/config.ts).
const networkIdKey = z.string().regex(/^\d+$/);
// An origin-relative path: exactly one leading slash. `//host` (protocol-relative)
// is deliberately rejected — it changes origin and would reintroduce the
// cross-origin/SSRF surface that relative URLs exist to remove.
const relativeUrlPath = z.string().regex(/^\/(?!\/)[^\s]*$/);
const aggkitBaseUrlString = z.union([urlString, relativeUrlPath]);
// Exported so app/config.ts can validate the NEXT_PUBLIC_AGGKIT_BRIDGE_APIS
// env override against the same shape, rather than re-declaring it.
export const aggkitBridgeApisSchema = z.record(networkIdKey, aggkitBaseUrlString);
// A single URL fronting every network for a mode -- one multiplexing
// aggkit-proxy instance (PROXY + TRACKER components, see docs/deployment.md)
// distinguishing networks by the `?network_id=` query param rather than by
// host. Same URL shape as one aggkitBridgeApis entry; exported so app/config.ts
// can validate the NEXT_PUBLIC_AGGKIT_PROXY env override against it.
export const aggkitProxySchema = aggkitBaseUrlString;

export const JsonNativeCurrencyConfigSchema = z
  .object({
    name: nonEmptyString,
    symbol: nonEmptyString,
    decimals: z.number().int().min(0)
  })
  .strict();

export const jsonChainConfigSchema = z
  .object({
    id: z.number().int().positive(),
    name: nonEmptyString,
    rpcUrl: urlString,
    explorerUrl: urlString,
    currency: JsonNativeCurrencyConfigSchema,
    iconUrl: urlString,
    networkId: z.number().int().min(0),
    isTestnet: z.boolean(),
    eta: z.number().int().min(0)
  })
  .strict();

export const jsonAppModeConfigSchema = z
  .object({
    label: nonEmptyString,
    bridgeAddress: addressString,
    // A single aggkit-proxy fronting every network in this mode, tracker
    // included. Set this for a mode whose backend is one multiplexing proxy
    // (e.g. devnet) -- mutually exclusive with aggkitBridgeApis below (see the
    // superRefine at the bottom of this schema): the two are genuinely
    // different backend shapes ("one proxy for everything" vs. "one REST
    // service per network"), and declaring both would leave it ambiguous
    // which one the app should actually call.
    aggkitProxy: aggkitProxySchema.optional(),
    // Per-network aggkit bridge API map, for modes whose networks are served
    // by distinct aggkit REST backends (e.g. mainnet/testnet, where each L2
    // has its own aggkit instance). May be omitted or {} for a mode that
    // doesn't yet have an aggkit backend configured at all (e.g.
    // mainnet/testnet before their aggkit instances are stood up) -- that is
    // the documented "not yet configured" escape hatch, and (like aggkitProxy
    // being absent) does not trip the mutual-exclusion check below.
    aggkitBridgeApis: aggkitBridgeApisSchema.optional(),
    chainKeys: z.array(nonEmptyString),
    defaultFromChainKey: nonEmptyString.optional(),
    defaultToChainKey: nonEmptyString.optional()
  })
  .strict()
  .superRefine((modeConfig, ctx) => {
    // "Neither" is the escape hatch above and always allowed. "Both" is
    // rejected: a mode fronted by one proxy and a mode addressing distinct
    // per-network backends are different deployment shapes, and silently
    // preferring one field over the other would hide a config author's
    // mistake (e.g. a stale aggkitBridgeApis map left behind after adding
    // aggkitProxy) rather than surface it.
    const declaresProxy = modeConfig.aggkitProxy !== undefined;
    const declaresBridgeApis = Object.keys(modeConfig.aggkitBridgeApis ?? {}).length > 0;
    if (declaresProxy && declaresBridgeApis) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          'aggkitProxy and aggkitBridgeApis are mutually exclusive: declare a single ' +
          'aggkitProxy for a mode fronted by one multiplexing proxy, or a per-network ' +
          'aggkitBridgeApis map for a mode with distinct per-network backends -- not both.'
      });
    }
  });

const routeAutoclaimSchema = z
  .object({
    // Whether an autoclaim service is expected to claim this route on the user's
    // behalf. When false, the manual "Claim tokens" button shows as soon as the
    // deposit is READY_TO_CLAIM (legacy behavior).
    expectedAutoclaim: z.boolean(),
    // Grace period (milliseconds, measured from when the deposit first becomes
    // READY_TO_CLAIM) to wait for the autoclaim service before surfacing the
    // manual claim button. Only used when expectedAutoclaim is true.
    waitForAutoclaimMs: z.number().int().min(0).optional()
  })
  .strict();

// Per-route autoclaim UX config. Optional in config.json — app/config.ts applies
// per-route defaults for any route omitted here.
export const autoclaimConfigSchema = z
  .object({
    l1_to_l2: routeAutoclaimSchema.optional(),
    l2_to_l1: routeAutoclaimSchema.optional(),
    l2_to_l2: routeAutoclaimSchema.optional()
  })
  .strict();

export const jsonConfigSchema = z
  .object({
    autoclaim: autoclaimConfigSchema.optional(),
    externalLinks: z
      .object({
        privacyPolicy: optionalUrlString,
        termsOfUse: optionalUrlString,
        contactSupport: optionalUrlString
      })
      .strict(),
    chains: z.record(nonEmptyString, jsonChainConfigSchema),
    appModes: z
      .object({
        default: modeEnum,
        configs: z.record(nonEmptyString, jsonAppModeConfigSchema)
      })
      .strict()
  })
  .strict();
