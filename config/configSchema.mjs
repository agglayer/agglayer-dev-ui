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
    // May be {} for modes that don't yet have an aggkit backend configured
    // (e.g. mainnet/testnet before their aggkit instances are stood up).
    aggkitBridgeApis: aggkitBridgeApisSchema,
    chainKeys: z.array(nonEmptyString),
    defaultFromChainKey: nonEmptyString.optional(),
    defaultToChainKey: nonEmptyString.optional()
  })
  .strict();

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
