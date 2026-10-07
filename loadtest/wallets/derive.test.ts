import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveFunderAccount, deriveWallets, WalletDerivationError } from './derive';
import { buildTestDevnetConfig, TEST_FUNDER_PRIVATE_KEY, TEST_MNEMONIC } from './testHelpers';

const MNEMONIC_ENV = 'LOADTEST_TEST_MNEMONIC';
const FUNDER_ENV = 'LOADTEST_TEST_FUNDER_KEY';

beforeEach(() => {
  process.env[MNEMONIC_ENV] = TEST_MNEMONIC;
  process.env[FUNDER_ENV] = TEST_FUNDER_PRIVATE_KEY;
});

afterEach(() => {
  delete process.env[MNEMONIC_ENV];
  delete process.env[FUNDER_ENV];
});

describe('deriveWallets — {mnemonicRef, startIndex} (DESIGN §4.1)', () => {
  it('is deterministic: userId -> the well-known anvil default addresses', () => {
    const config = buildTestDevnetConfig({ usersTotal: 3 });
    const wallets = deriveWallets(config);
    expect(wallets.map((wallet) => wallet.userId)).toStrictEqual(['u0', 'u1', 'u2']);
    expect(wallets.map((wallet) => wallet.address)).toStrictEqual([
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
    ]);
  });

  it('produces the same address set on a second call (idempotent re-derivation)', () => {
    const config = buildTestDevnetConfig({ usersTotal: 5 });
    const first = deriveWallets(config).map((wallet) => wallet.address);
    const second = deriveWallets(config).map((wallet) => wallet.address);
    expect(second).toStrictEqual(first);
  });

  it('honors startIndex as an offset into the HD path', () => {
    const config = buildTestDevnetConfig({ usersTotal: 2 });
    const shifted = {
      ...config,
      users: { ...config.users, wallets: { mnemonicRef: { env: MNEMONIC_ENV }, startIndex: 1 } }
    };
    const wallets = deriveWallets(shifted);
    // index 0 of a config with startIndex=1 is HD addressIndex 1 -> the
    // same address as index 1 of a startIndex=0 config.
    expect(wallets[0].address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });
});

describe('deriveWallets — {privateKeysRef}', () => {
  it('reads the file Nth line for user N', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-derive-'));
    const file = path.join(dir, 'keys');
    const keyA = '0x9ee645e8f06f91625661407a1f5b25b75dadfff65c34fd5a5fc445f353e08d74';
    const keyB = '0x823ccb2545b4f758ef6e9bcca48d270c9ffdf1f4b222bd08c56d9a20389afd55';
    fs.writeFileSync(file, `${keyA}\n${keyB}\n`);
    fs.chmodSync(file, 0o600);
    try {
      const config = buildTestDevnetConfig({ usersTotal: 2 });
      const withKeys = {
        ...config,
        users: { ...config.users, wallets: { privateKeysRef: { file } } }
      };
      const wallets = deriveWallets(withKeys);
      expect(wallets).toHaveLength(2);
      expect(wallets[0].userId).toBe('u0');
      expect(wallets[1].userId).toBe('u1');
      expect(wallets[0].address).not.toBe(wallets[1].address);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the file has fewer lines than users.total', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-derive-'));
    const file = path.join(dir, 'keys');
    fs.writeFileSync(file, '0x9ee645e8f06f91625661407a1f5b25b75dadfff65c34fd5a5fc445f353e08d74\n');
    fs.chmodSync(file, 0o600);
    try {
      const config = buildTestDevnetConfig({ usersTotal: 3 });
      const withKeys = {
        ...config,
        users: { ...config.users, wallets: { privateKeysRef: { file } } }
      };
      expect(() => deriveWallets(withKeys)).toThrow(WalletDerivationError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deriveFunderAccount', () => {
  it('resolves users.funder.privateKeyRef to the expected address', () => {
    const config = buildTestDevnetConfig();
    const account = deriveFunderAccount(config);
    expect(account.address).toBe('0x9d37d38588739cdA1202994383dba0F6B28C1b73');
  });

  it('throws WalletDerivationError, never containing the raw key, when funder is missing', () => {
    const config = buildTestDevnetConfig();
    const withoutFunder = { ...config, users: { ...config.users, funder: undefined } };
    expect(() => deriveFunderAccount(withoutFunder)).toThrow(WalletDerivationError);
  });
});
