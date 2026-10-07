// Thin viem client construction + funder nonce discipline (DESIGN §4.4),
// shared by wallets/fund.ts and wallets/preflight.ts. Isolated in its own
// module so tests can inject a fully mocked `ChainClientFactory` — the
// acceptance criterion "prod/testnet path is unit-tested with a mocked viem
// client" (S05 goal) depends on fund.ts/preflight.ts never constructing a
// client directly, always going through a factory that a test can replace.
import type {
  Address,
  Chain,
  LocalAccount,
  PublicClient,
  TestClient,
  Transport,
  WalletClient
} from 'viem';

import { createPublicClient, createTestClient, createWalletClient, http } from 'viem';

import type { LoadtestChain } from '../config/schema';

// A minimal viem Chain built from the loadtest config's chain fields — the
// loadtest tool talks to arbitrary devnet/testnet/mainnet chains named only
// by chainId + rpcUrl in loadtest.config.json, not to viem's built-in chain
// registry.
export const toViemChain = (chain: LoadtestChain): Chain => ({
  id: chain.chainId,
  name: chain.key,
  nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [chain.rpcUrl] } }
});

export interface ChainClientSet {
  public: PublicClient;
  // Anvil `test` actions (DESIGN §4.2 `anvil_setBalance`). Only ever called
  // on the devnet path; constructing it is free (no network call), so it's
  // always present rather than optional.
  test: TestClient;
  // Concretely typed with Chain + LocalAccount filled in (not the fully
  // generic `WalletClient`, whose default `Account | undefined` /
  // `Chain | undefined` type parameters make every action require an
  // explicit `account`/`chain` argument per call) — this is exactly the
  // shape `createWalletClient({ account, chain, transport })` below
  // produces, so fund.ts's `sendTransaction`/`writeContract` calls need
  // only the account-derived nonce, not a repeated account/chain.
  wallet: (account: LocalAccount) => WalletClient<Transport, Chain, LocalAccount>;
}

export type ChainClientFactory = (chain: LoadtestChain) => ChainClientSet;

export const defaultChainClientFactory: ChainClientFactory = (chain) => {
  const viemChain = toViemChain(chain);
  const transport = http(chain.rpcUrl);
  return {
    public: createPublicClient({ chain: viemChain, transport }),
    test: createTestClient({ mode: 'anvil', chain: viemChain, transport }),
    wallet: (account) => createWalletClient({ account, chain: viemChain, transport })
  };
};

/**
 * DESIGN §4.4: "the funder maintains one in-memory nonce counter per chain,
 * seeded from `eth_getTransactionCount(pending)`, and all its sends on a
 * chain go through a single-slot queue. Different chains proceed
 * concurrently. On any send error the counter is re-seeded from the node
 * rather than incremented blindly."
 *
 * `nextNonce()` calls are serialized against each other (the "single-slot
 * queue") so concurrent callers never observe the same nonce twice, but a
 * caller does NOT have to await the send itself before requesting the next
 * nonce — nonces can be handed out as fast as sends are issued, which is
 * what keeps `fund` fast (S05 acceptance: 20 users funded in well under
 * 60s). `onSendError()` invalidates the cached nonce so the *next* call
 * re-seeds from the node instead of trusting the in-memory counter, which
 * may now be wrong (e.g. the failed send's nonce was never actually
 * consumed on-chain).
 */
export class ChainNonceManager {
  private nonce: number | undefined;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly publicClient: PublicClient,
    private readonly address: Address
  ) {}

  nextNonce(): Promise<number> {
    const result = this.queue.then(async () => {
      if (this.nonce === undefined) {
        this.nonce = await this.publicClient.getTransactionCount({
          address: this.address,
          blockTag: 'pending'
        });
      }
      const assigned = this.nonce;
      this.nonce += 1;
      return assigned;
    });
    // Chain the next slot on this attempt regardless of outcome, so one
    // rejected nonce request doesn't wedge the queue for every caller after
    // it.
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** DESIGN §4.4: re-seed from the node after any send error. */
  onSendError(): void {
    this.nonce = undefined;
  }
}
