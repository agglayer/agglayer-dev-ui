// DESIGN §4.1: N accounts from a mnemonic+index or from explicit keys,
// deterministic `userId -> address`. Deterministic derivation is what makes
// a re-run comparable and `fund`'s skip-if-funded idempotent — the same
// config must yield the same wallet set on every run.
import type { Address, Hex, LocalAccount } from 'viem';

import { toHex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import type { LoadtestConfig } from '../config/schema';

import { resolveSecret, resolveSecretLines } from './secrets';

export class WalletDerivationError extends Error {}

export interface DerivedWallet {
  userId: string; // 'u0'..'u{users.total - 1}'
  index: number;
  address: Address;
  account: LocalAccount;
  // S11: the raw private key, needed to seed a browser-mode context's
  // `window.__AGGLAYER_E2E_PRIVATE_KEY__` (`workers/browser/pool.ts`'s
  // `BrowserPoolUserSpec`). Not otherwise recoverable from a viem
  // `LocalAccount` — a `PrivateKeyAccount` never exposes it, and an
  // `HDAccount`'s underlying key is reachable only via
  // `account.getHdKey().privateKey`, a method the `LocalAccount` type below
  // erases — so it is captured once, here, at derivation time.
  privateKey: Hex;
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const userIdFor = (index: number): string => `u${index}`;

/**
 * DESIGN §4.1: `{mnemonicRef, startIndex}` -> BIP-44 path
 * `m/44'/60'/0'/0/{startIndex+index}` (viem's default HD path when only
 * `addressIndex` is given — `viem/accounts/hdKeyToAccount.ts`).
 * `{privateKeysRef}` -> the file's Nth line for user N; refuses if the file
 * has fewer lines than `users.total`.
 */
export const deriveWallets = (config: LoadtestConfig): DerivedWallet[] => {
  const { wallets, total } = config.users;

  if ('mnemonicRef' in wallets) {
    const mnemonic = resolveSecret(wallets.mnemonicRef, 'users.wallets.mnemonicRef');
    return Array.from({ length: total }, (_, index) => {
      const account = mnemonicToAccount(mnemonic, { addressIndex: wallets.startIndex + index });
      const rawKey = account.getHdKey().privateKey;
      if (!rawKey) {
        throw new WalletDerivationError(`could not derive a private key for user index ${index}`);
      }
      return {
        userId: userIdFor(index),
        index,
        address: account.address,
        account,
        privateKey: toHex(rawKey)
      };
    });
  }

  const lines = resolveSecretLines(wallets.privateKeysRef, 'users.wallets.privateKeysRef');
  if (lines.length < total) {
    throw new WalletDerivationError(
      `users.wallets.privateKeysRef resolved to ${lines.length} line(s) but users.total is ${total} — the file must have at least one key per user`
    );
  }

  return Array.from({ length: total }, (_, index) => {
    const line = lines[index];
    if (!PRIVATE_KEY_PATTERN.test(line)) {
      throw new WalletDerivationError(
        `users.wallets.privateKeysRef line ${index + 1} is not a 0x-prefixed 32-byte private key`
      );
    }
    const account = privateKeyToAccount(line as `0x${string}`);
    return {
      userId: userIdFor(index),
      index,
      address: account.address,
      account,
      privateKey: line as Hex
    };
  });
};

/**
 * Resolves `users.funder.privateKeyRef` to a signer account. Used both to
 * fund testnet/mainnet wallets (DESIGN §4.3) and, on devnet, as the ERC20
 * transfer sender (DESIGN §4.2 — the devnet funder key IS the e2e wallet
 * that holds `erc20_address`'s supply).
 */
export const deriveFunderAccount = (config: LoadtestConfig): LocalAccount => {
  if (config.users.funder === undefined) {
    throw new WalletDerivationError(
      'users.funder is not configured — cannot derive a funder account'
    );
  }
  const key = resolveSecret(config.users.funder.privateKeyRef, 'users.funder.privateKeyRef');
  if (!PRIVATE_KEY_PATTERN.test(key)) {
    throw new WalletDerivationError(
      'users.funder.privateKeyRef did not resolve to a 0x-prefixed 32-byte private key'
    );
  }
  return privateKeyToAccount(key as `0x${string}`);
};
