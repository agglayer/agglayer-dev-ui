// S53 redaction items (heavy-load design §5): the render-time helpers that keep
// an RPC provider key, userinfo, secret-file directories and home paths out of
// anything a report prints. Every "secret" below is an obviously fake value.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadtestConfigSchema, parseLoadtestConfig } from '../config/schema';
import { buildTestDevnetConfig } from '../wallets/testHelpers';
import {
  allowlistedConfigView,
  CONFIG_KEY_POLICY,
  redactEndpointClass,
  redactUrlForDisplay,
  refLabel,
  safeUrlLabel
} from './redactReport';

const TOKEN = 'AbCdEf0123456789TokenXyz';
// A made-up home directory, assembled at run time so no literal machine path lives in the file.
const FAKE_HOME = ['', 'home', 'someone'].join('/');

describe('safeUrlLabel', () => {
  it('shows scheme://host[:port] only, flagging a dropped path', () => {
    expect(safeUrlLabel(`https://rpc.example.invalid/${TOKEN}`)).toBe(
      'https://rpc.example.invalid (path/query redacted)'
    );
    expect(safeUrlLabel('http://127.0.0.1:8555/aggkitapi')).toBe(
      'http://127.0.0.1:8555 (path/query redacted)'
    );
  });

  it('flags query, fragment and userinfo, and never prints them', () => {
    for (const url of [
      'https://h.example.invalid/?apikey=SECRETQ',
      'https://h.example.invalid?apikey=SECRETQ',
      'https://h.example.invalid#SECRETF',
      'https://user:p4ss@h.example.invalid'
    ]) {
      const label = safeUrlLabel(url);
      expect(label).toBe('https://h.example.invalid (path/query redacted)');
      expect(label).not.toMatch(/SECRET|p4ss|user/);
    }
  });

  it('leaves a bare origin unflagged, keeps an empty value empty and masks garbage', () => {
    expect(safeUrlLabel('https://l1.example.invalid')).toBe('https://l1.example.invalid');
    expect(safeUrlLabel('https://l1.example.invalid/')).toBe('https://l1.example.invalid');
    expect(safeUrlLabel('')).toBe('');
    expect(safeUrlLabel(undefined)).toBe('');
    expect(safeUrlLabel('not a url')).toBe('<redacted url>');
  });
});

describe('redactUrlForDisplay (summary.md)', () => {
  it('keeps a secret-free URL byte-for-byte, path included', () => {
    expect(redactUrlForDisplay('http://127.0.0.1:8555/aggkitapi')).toBe(
      'http://127.0.0.1:8555/aggkitapi'
    );
    expect(redactUrlForDisplay('https://aggkit-proxy-devnet.example.invalid')).toBe(
      'https://aggkit-proxy-devnet.example.invalid'
    );
  });

  it('rewrites a URL with a token-shaped path segment, query, fragment or userinfo', () => {
    for (const url of [
      `https://rpc.example.invalid/${TOKEN}`,
      `https://rpc.example.invalid/v3/${TOKEN}`,
      'https://h.example.invalid/proxy?apikey=SECRETQ',
      'https://h.example.invalid/proxy#SECRETF',
      'https://user:p4ss@h.example.invalid/proxy'
    ]) {
      const out = redactUrlForDisplay(url);
      expect(out).toMatch(/^https:\/\/[a-z.]+\.invalid\/<redacted>$/);
      expect(out).not.toMatch(/AbCdEf|SECRET|p4ss|user/);
    }
  });
});

describe('refLabel', () => {
  it('shows an env var name, only the basename of a file, and understands the results.json shape', () => {
    expect(refLabel({ env: 'LOADTEST_MNEMONIC' })).toBe('env:LOADTEST_MNEMONIC');
    expect(refLabel({ file: `${FAKE_HOME}/secret.txt` })).toBe('file:secret.txt');
    expect(refLabel({ ref: 'env:LOADTEST_MNEMONIC' })).toBe('env:LOADTEST_MNEMONIC');
    expect(refLabel({ ref: `file:${FAKE_HOME}/keys/secret.txt` })).toBe('file:secret.txt');
    expect(refLabel({ file: 'C:\\Users\\someone\\secret.txt' })).toBe('file:secret.txt');
    expect(refLabel('0xnot-a-ref')).toBe('<unknown ref>');
    expect(refLabel(undefined)).toBe('<unknown ref>');
  });

  it('never leaks the directory of a file ref', () => {
    expect(refLabel({ file: `${FAKE_HOME}/secret.txt` })).not.toContain('someone');
  });
});

describe('redactEndpointClass — endpoint-name mapping (F1)', () => {
  const config = {
    chains: [
      { key: 'BALI_82', rpcUrl: `https://rpc.example.invalid/${TOKEN}` },
      { key: 'SEPOLIA', rpcUrl: 'https://l1.example.invalid' },
      { key: 'DEVNET_L1', rpcUrl: 'http://127.0.0.1:8555/l1rpc' }
    ]
  };

  it('maps a keyed segment to the chain key that owns that URL, keeping the method', () => {
    expect(redactEndpointClass(`rpc/${TOKEN}/eth_call`, config)).toBe('rpc/BALI_82/eth_call');
    expect(redactEndpointClass(`rpc/${TOKEN}`, config)).toBe('rpc/BALI_82');
  });

  it('maps an unknown token-shaped segment to rpc/redacted', () => {
    expect(redactEndpointClass('rpc/ZyXwVu9876543210OtherKey/eth_call', config)).toBe(
      'rpc/redacted/eth_call'
    );
  });

  it('maps the host of a configured chain to its key (S55)', () => {
    expect(redactEndpointClass('rpc/l1.example.invalid', config)).toBe('rpc/SEPOLIA');
  });

  it('leaves chain keys, hosts, IPs and short path names alone, so keyless runs render as before', () => {
    for (const cls of [
      'rpc/BALI_82/eth_call',
      'rpc/34.153.133.172/eth_call',
      'rpc/l1rpc/eth_call',
      'rpc/l2rpc-001',
      'tracker/activity',
      'bridge/claim-proof[1]',
      'unknown'
    ]) {
      expect(redactEndpointClass(cls, config)).toBe(cls);
    }
  });

  it('a chain key that is itself token-shaped (>= 16 chars) is kept, not redacted', () => {
    const long = { chains: [{ key: 'BASE_SEPOLIA_TESTNET', rpcUrl: 'https://h.example.invalid' }] };
    expect(redactEndpointClass('rpc/BASE_SEPOLIA_TESTNET/eth_call', long)).toBe(
      'rpc/BASE_SEPOLIA_TESTNET/eth_call'
    );
  });
});

// ---------------------------------------------------------------------------
// allowlistedConfigView
// ---------------------------------------------------------------------------

const seededConfig = () => {
  const base = buildTestDevnetConfig();
  return parseLoadtestConfig({
    ...base,
    env: 'testnet',
    chains: base.chains.map((chain, index) => ({
      ...chain,
      rpcUrl: index === 0 ? `https://rpc.example.invalid/${TOKEN}` : chain.rpcUrl,
      explorerUrl: index === 1 ? 'https://u:p@explorer.example.invalid/x?apikey=SECRETQ' : ''
    })),
    aggkitProxyUrl: 'https://h.example.invalid/proxy?apikey=SECRETQ',
    users: {
      ...base.users,
      devnetFunding: undefined,
      wallets: { mnemonicRef: { file: `${FAKE_HOME}/secret.txt` }, startIndex: 0 },
      funder: {
        ...base.users.funder,
        privateKeyRef: { file: `${FAKE_HOME}/funder.key` },
        maxTotalErc20Spend: '1'
      }
    },
    pump: {
      enabled: true,
      chainKey: 'L1',
      destinationNetworkId: 1,
      walletIndex: 999,
      amount: '0',
      intervalSeconds: 600,
      maxTotalSpend: '0.07',
      maxGasPriceGwei: 5
    },
    measurement: {
      stageProbeIntervalMs: 5000,
      walletBalanceIntervalMs: 300_000,
      l1InfoTree: { pollIntervalMs: 60_000 },
      httpWindowMs: 60_000,
      claimPreState: true
    },
    output: { dir: `${FAKE_HOME}/work/out`, activityLog: true }
  });
};

describe('allowlistedConfigView', () => {
  it('prints no URL path, query, userinfo, secret-file directory or home path', () => {
    const text = JSON.stringify(allowlistedConfigView(seededConfig()));
    for (const forbidden of [TOKEN, 'SECRETQ', 'p4ss', 'u:p@', FAKE_HOME, 'someone', 'proxy?']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).toContain('https://rpc.example.invalid (path/query redacted)');
    expect(text).toContain('file:secret.txt');
    expect(text).toContain('file:funder.key');
  });

  it('shows the output directory by basename and the pump sender when given', () => {
    const view = allowlistedConfigView(seededConfig(), {
      pumpSender: '0x00000000000000000000000000000000000000b1'
    });
    expect(view.output).toStrictEqual({ dir: 'out' });
    expect((view.pump as Record<string, unknown>).sender).toBe(
      '0x00000000000000000000000000000000000000b1'
    );
    expect((view.pump as Record<string, unknown>).walletIndex).toBe(999);
    expect((view.measurement as Record<string, unknown>).l1InfoTree).toStrictEqual({
      pollIntervalMs: 60_000
    });
  });

  it('is the same for the results.json shape ({ref} instead of {env}/{file})', () => {
    const live = JSON.stringify(allowlistedConfigView(seededConfig()));
    const stored = JSON.parse(JSON.stringify(seededConfig())) as Record<string, unknown>;
    const users = stored.users as Record<string, Record<string, unknown>>;
    users.wallets.mnemonicRef = { ref: `file:${FAKE_HOME}/secret.txt` };
    users.funder.privateKeyRef = { ref: `file:${FAKE_HOME}/funder.key` };
    expect(JSON.stringify(allowlistedConfigView(stored))).toBe(live);
  });

  it('omits optional blocks that are absent and does not add pump/measurement keys', () => {
    const view = allowlistedConfigView(buildTestDevnetConfig());
    expect('pump' in view).toBe(false);
    expect('measurement' in view).toBe(false);
  });

  it('copies hidden keys nowhere', () => {
    const text = JSON.stringify(allowlistedConfigView(seededConfig()));
    expect(text).not.toContain('activityLog');
  });

  it('survives a malformed config without throwing', () => {
    expect(() => allowlistedConfigView(undefined)).not.toThrow();
    expect(() => allowlistedConfigView({ chains: 'nope', users: 7 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema-key classification: a new config field must be given a policy.
// ---------------------------------------------------------------------------

type ZodNode = { _zod: { def: Record<string, unknown> & { type: string } } };

const leafPaths = (node: ZodNode, prefix: string): string[] => {
  const def = node._zod.def;
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
      return leafPaths(def.innerType as ZodNode, prefix);
    case 'pipe':
      return leafPaths(def.in as ZodNode, prefix);
    case 'object': {
      const shape = def.shape as Record<string, ZodNode>;
      return Object.entries(shape).flatMap(([key, child]) =>
        leafPaths(child, prefix === '' ? key : `${prefix}.${key}`)
      );
    }
    case 'array':
      return leafPaths(def.element as ZodNode, `${prefix}[]`);
    case 'record':
      return leafPaths(def.valueType as ZodNode, `${prefix}.*`);
    case 'union':
      return (def.options as ZodNode[]).flatMap((option) => leafPaths(option, prefix));
    default:
      return [prefix];
  }
};

describe('CONFIG_KEY_POLICY covers the whole config schema', () => {
  const schemaLeaves = [
    ...new Set(leafPaths(loadtestConfigSchema as unknown as ZodNode, ''))
  ].sort();

  it('walks a plausible number of leaves (guards the walker itself)', () => {
    expect(schemaLeaves.length).toBeGreaterThan(50);
    expect(schemaLeaves).toContain('chains[].rpcUrl');
    expect(schemaLeaves).toContain('pump.maxGasPriceGwei');
    expect(schemaLeaves).toContain('measurement.l1InfoTree.pollIntervalMs');
    expect(schemaLeaves).toContain('autoclaim.*.waitMs');
    expect(schemaLeaves).toContain('users.wallets.mnemonicRef.file');
  });

  it('every schema leaf has a policy (a new field cannot reach a report undecided)', () => {
    const undecided = schemaLeaves.filter((leaf) => !(leaf in CONFIG_KEY_POLICY));
    expect(undecided).toStrictEqual([]);
  });

  it('every policy entry names a real schema leaf (no stale entries)', () => {
    const stale = Object.keys(CONFIG_KEY_POLICY).filter((key) => !schemaLeaves.includes(key));
    expect(stale).toStrictEqual([]);
  });

  it('every URL-valued and secret-ref leaf is declared as such, never `show`', () => {
    for (const leaf of schemaLeaves) {
      if (/(^|\.)(rpcUrl|explorerUrl|aggkitProxyUrl|uiBaseUrl)$/.test(leaf)) {
        expect(CONFIG_KEY_POLICY[leaf], leaf).toBe('url');
      }
      if (/(mnemonicRef|privateKeysRef|privateKeyRef)\.(env|file)$/.test(leaf)) {
        expect(CONFIG_KEY_POLICY[leaf], leaf).toBe('secretRef');
      }
    }
  });

  it('z is the same zod the schema was built with (sanity)', () => {
    expect(z.string().safeParse('x').success).toBe(true);
  });
});
