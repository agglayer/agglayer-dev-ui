import { describe, expect, it } from 'vitest';

import { normalizeConfigOrThrow, resolveAggkitProxyUrl } from './configLoader.mjs';

// Same fixture shape as configValidator.test.mjs (design.md §4/§5): a
// schema-valid, semantically-valid devnet config with three chains and one
// enabled mode. Callers mutate `aggkitProxy` per test to exercise
// resolution/rejection of relative and protocol-relative URLs.
const chain = (overrides = {}) => ({
  id: 1,
  name: 'Chain',
  rpcUrl: 'https://rpc.example',
  explorerUrl: 'https://explorer.example',
  currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  iconUrl: 'https://icon.example/icon.svg',
  networkId: 0,
  isTestnet: true,
  eta: 1,
  ...overrides
});

const buildConfig = (aggkitProxy) => ({
  walletConnect: { projectId: 'test-project-id' },
  externalLinks: { privacyPolicy: '', termsOfUse: '', contactSupport: '' },
  chains: {
    DEVNET_L1: chain({ id: 271828, name: 'Devnet L1', networkId: 0 }),
    DEVNET_L2_001: chain({ id: 20201, name: 'Devnet L2-001', networkId: 1 }),
    DEVNET_L2_002: chain({ id: 20202, name: 'Devnet L2-002', networkId: 2 })
  },
  appModes: {
    default: 'devnet',
    configs: {
      devnet: {
        label: 'Devnet',
        bridgeAddress: '0xC8cbEBf950B9Df44d987c8619f092beA980fF038',
        ...(aggkitProxy === undefined ? {} : { aggkitProxy }),
        chainKeys: ['DEVNET_L1', 'DEVNET_L2_001', 'DEVNET_L2_002'],
        defaultFromChainKey: 'DEVNET_L1',
        defaultToChainKey: 'DEVNET_L2_001'
      }
    }
  }
});

describe('resolveAggkitProxyUrl (design.md §5.4)', () => {
  it('passes an absolute URL through unchanged, regardless of origin', () => {
    expect(
      resolveAggkitProxyUrl('https://aggkit.example/aggkitapi', 'http://origin.example', false)
    ).toBe('https://aggkit.example/aggkitapi');
    expect(resolveAggkitProxyUrl('https://aggkit.example/aggkitapi', undefined, false)).toBe(
      'https://aggkit.example/aggkitapi'
    );
  });

  it('resolves a relative path against the given origin', () => {
    expect(resolveAggkitProxyUrl('/aggkitapi', 'http://origin.example', false)).toBe(
      'http://origin.example/aggkitapi'
    );
  });

  it('strips a trailing slash from the origin before concatenating', () => {
    expect(resolveAggkitProxyUrl('/aggkitapi', 'http://origin.example/', false)).toBe(
      'http://origin.example/aggkitapi'
    );
  });

  it('leaves a relative path untouched when allowRelative is true and origin is undefined (validate-only paths)', () => {
    expect(resolveAggkitProxyUrl('/aggkitapi', undefined, true)).toBe('/aggkitapi');
  });

  it('throws loudly for a relative path with no origin and allowRelative false', () => {
    expect(() => resolveAggkitProxyUrl('/aggkitapi', undefined, false)).toThrow(
      /APP_CONFIG_INVALID: relative aggkitProxy URL "\/aggkitapi" requires an origin/
    );
  });
});

describe('normalizeConfigOrThrow — URL normalization (design.md §5, A-5 item 3)', () => {
  it('resolves a relative aggkitProxy value against the given origin', () => {
    const result = normalizeConfigOrThrow(buildConfig('/aggkitapi'), {
      sourceName: 'config.json',
      origin: 'https://served-from.example'
    });

    expect(result.appModes.configs.devnet.aggkitProxy).toBe(
      'https://served-from.example/aggkitapi'
    );
  });

  it('passes an already-absolute aggkitProxy value through unchanged', () => {
    const result = normalizeConfigOrThrow(buildConfig('https://aggkit.example/1'), {
      sourceName: 'config.json',
      origin: 'https://served-from.example'
    });

    expect(result.appModes.configs.devnet.aggkitProxy).toBe('https://aggkit.example/1');
  });

  it('leaves a relative entry byte-for-byte when allowRelative is set and no origin is given (sync/validate scripts)', () => {
    const raw = buildConfig('/aggkitapi');

    const result = normalizeConfigOrThrow(raw, { sourceName: 'config.json', allowRelative: true });

    expect(result.appModes.configs.devnet.aggkitProxy).toBe('/aggkitapi');
  });

  it('never mutates its input', () => {
    const raw = buildConfig('/aggkitapi');
    const before = JSON.parse(JSON.stringify(raw));

    normalizeConfigOrThrow(raw, {
      sourceName: 'config.json',
      origin: 'https://served-from.example'
    });

    expect(raw).toEqual(before);
  });

  it('rejects a protocol-relative URL ("//evil.example") at the schema level -- the security-relevant case', () => {
    const raw = buildConfig('//evil.example');

    expect(() =>
      normalizeConfigOrThrow(raw, {
        sourceName: 'config.json',
        origin: 'https://served-from.example'
      })
    ).toThrow(
      /config\.json schema validation failed:\n- appModes\.configs\.devnet\.aggkitProxy: Invalid input/
    );
  });

  // X-1 regression guard. zod's `.url()` only requires that a value parse as a
  // URL, so before configSchema.mjs constrained the scheme it accepted
  // `javascript:` and `data:` everywhere a URL was expected. config.json is
  // mounted at container start, and `externalLinks.*` / `explorerUrl` reach
  // `<a href>` and `window.open(...)` unmodified -- a `javascript:` value
  // there was demonstrated to execute with the app's own origin (reading
  // document.cookie and localStorage). Every URL field must stay http(s)-only.
  it.each([
    [
      'externalLinks.contactSupport',
      (cfg) => (cfg.externalLinks.contactSupport = 'javascript:alert(1)')
    ],
    [
      'externalLinks.privacyPolicy',
      (cfg) => (cfg.externalLinks.privacyPolicy = 'data:text/html,<script>1</script>')
    ],
    [
      'chains.DEVNET_L1.explorerUrl',
      (cfg) => (cfg.chains.DEVNET_L1.explorerUrl = 'javascript:alert(1)')
    ],
    ['chains.DEVNET_L1.iconUrl', (cfg) => (cfg.chains.DEVNET_L1.iconUrl = 'javascript:alert(1)')],
    ['chains.DEVNET_L1.rpcUrl', (cfg) => (cfg.chains.DEVNET_L1.rpcUrl = 'file:///etc/passwd')],
    [
      'appModes.configs.devnet.aggkitProxy',
      (cfg) => (cfg.appModes.configs.devnet.aggkitProxy = 'javascript:alert(1)')
    ]
  ])('rejects a non-http(s) URL scheme in %s', (_field, mutate) => {
    const raw = buildConfig('https://aggkit.example/1');
    mutate(raw);

    expect(() =>
      normalizeConfigOrThrow(raw, {
        sourceName: 'config.json',
        origin: 'https://served-from.example'
      })
    ).toThrow(/schema validation failed/);
  });

  it('still accepts plain http and https URLs', () => {
    const raw = buildConfig('http://127.0.0.1:8555/aggkitapi');

    expect(() =>
      normalizeConfigOrThrow(raw, {
        sourceName: 'config.json',
        origin: 'https://served-from.example'
      })
    ).not.toThrow();
  });

  it('rejects a bare relative path with no leading slash ("aggkitapi")', () => {
    const raw = buildConfig('aggkitapi');

    expect(() => normalizeConfigOrThrow(raw, { sourceName: 'config.json' })).toThrow(
      /schema validation failed/
    );
  });

  it('leaves aggkitProxy untouched (absent) when the field is omitted entirely', () => {
    const result = normalizeConfigOrThrow(buildConfig(undefined), {
      sourceName: 'config.json',
      origin: 'https://served-from.example'
    });

    expect(result.appModes.configs.devnet.aggkitProxy).toBeUndefined();
  });

  it('rejects the removed aggkitBridgeApis map as an unrecognized key', () => {
    const raw = buildConfig('https://aggkit.example/1');
    raw.appModes.configs.devnet.aggkitBridgeApis = { 1: 'https://aggkit.example/1' };

    expect(() => normalizeConfigOrThrow(raw, { sourceName: 'config.json' })).toThrow(
      /config\.json schema validation failed:\n- appModes\.configs\.devnet: Unrecognized key: "aggkitBridgeApis"/
    );
  });
});

// X-1: the protocol-relative rejection must not live only in the schema.
// resolveAggkitProxyUrl is exported and is called directly by app/config.ts's
// NEXT_PUBLIC_AGGKIT_PROXY path, so it carries its own guard -- otherwise any
// future caller that skips the schema would silently turn "//evil.example"
// into a cross-origin request.
describe('resolveAggkitProxyUrl — protocol-relative guard (X-1)', () => {
  it('throws for "//host" even with an origin supplied', () => {
    expect(() => resolveAggkitProxyUrl('//evil.example', 'https://app.example', false)).toThrow(
      /protocol-relative/
    );
  });

  it('throws for "//host" on the allowRelative branch, where the value would be returned verbatim', () => {
    expect(() => resolveAggkitProxyUrl('//evil.example', undefined, true)).toThrow(
      /protocol-relative/
    );
  });
});
