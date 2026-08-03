# Agglayer Dev UI

The Agglayer Dev UI is a configurable, self-hosted bridging interface powered by the [Agglayer SDK](https://github.com/agglayer/sdk) and the [aggkit bridge service](https://github.com/agglayer/aggkit).

## Quickstart

1) Install dependencies:

```bash
pnpm install
```

2) Configure the app:

Edit `config.json` at the project root to set chains, app modes, aggkit bridge APIs, and external links. See [`docs/config.md`](docs/config.md) for the full guide.

Set `NEXT_PUBLIC_PROJECT_ID` (WalletConnect project ID) in `.env.local`.
Optionally set `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` to override `config.json` per environment:

```bash
cp .env.example .env.local
```

3) Run the dev server:

```bash
pnpm run dev
```

Open `http://localhost:3000`.

## Scripts

- `pnpm run dev` — start dev server
- `pnpm run build` — production build
- `pnpm run start` — run production server
- `pnpm run lint` — lint
- `pnpm run validate:config` — validate `config.json`
- `pnpm run typecheck` — TypeScript checks
- `pnpm run test` — unit tests (Vitest)
- `pnpm run test:e2e` — end-to-end tests (Playwright)
- `node scripts/kurtosisDevnetEnv.mjs [--enclave cdk]` — bring up devnet config from a running Kurtosis enclave (see below)

### Kurtosis devnet bring-up

Against a running Kurtosis `cdk` enclave (see the `kurtosis-cdk` repo, `bridge_ui_backend: aggkit` mode), this script eliminates manual port copying:

```bash
node scripts/kurtosisDevnetEnv.mjs --enclave cdk
```

It resolves the enclave's ephemeral ports live (`kurtosis port print`), then:

- writes `config.json`'s `chains` with `DEVNET_L1`, `DEVNET_L2_001`, `DEVNET_L2_002` (for 2-L2 enclaves) and `appModes.configs.devnet` with the live L1/L2 RPC URLs, chain ids (read via `eth_chainId`), and bridge address (verified deployed via `eth_getCode`);
- writes `.env.local` with `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` pointed at the enclave's CORS-safe haproxy proxy (same URL under both networkId keys, routed via `?network_id=`), `E2E_PRIVATE_KEY` set to a pre-funded devnet key, and for 2-L2 enclaves: `E2E_TO_CHAIN_ID` and `E2E_L2_CHAIN_IDS`.

Re-run it after every enclave recreate (ports are ephemeral). It fails with a clear error if the named enclave doesn't exist. Only supports Kurtosis-based devnets.

## Testing

Playwright E2E defaults to the local Kurtosis `cdk` devnet (aggkit backend)
using a funded devnet key -- see "Kurtosis devnet bring-up" above. Set
`E2E_BACKEND_MODE=testnet` in `.env.local` to instead run against real
Sepolia/Bokuto testnet infrastructure (the pre-aggkit-migration behavior).
All backend-specific values (chain ids, ERC20 address, bridge amounts,
timeouts) are resolved by `app/constants/e2e.ts` per mode -- see that file
for the exact defaults and overrides, and `.env.example` for the full list
of E2E-only env vars.

Security and ops notes:

- The E2E private key is injected into the browser runtime for automated signing. Never reuse a real wallet key.
- Keep the E2E wallet balance minimal and treat it as disposable.
- Never deploy with `NEXT_PUBLIC_E2E_ENABLED=true` in any public/shared environment.
- Set only `E2E_PRIVATE_KEY` in `.env.local` for tests. Do not set `NEXT_PUBLIC_E2E_PRIVATE_KEY` directly.
- Testnet-mode spend accumulates over CI runs; periodically top up the E2E wallet.

Required `.env.local` variables for E2E:

- `E2E_PRIVATE_KEY`
- `NEXT_PUBLIC_PROJECT_ID`
- `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS` (devnet mode: written by `scripts/kurtosisDevnetEnv.mjs`)

**2-L2 devnet E2E-specific variables** (both set by `kurtosisDevnetEnv.mjs` for 2-L2 enclaves):

- `E2E_TO_CHAIN_ID` — destination chain ID for L2→L2 tests (e.g., `20202` for L2-2)
- `E2E_L2_CHAIN_IDS` — comma-separated list of all L2 chain IDs (e.g., `20201,20202`)

Devnet mode also runs a Playwright `globalSetup` (`tests/e2e/globalSetup.ts`)
before any spec: it resolves a usable ERC20 for
`tests/bridge/erc20-approve-bridge.spec.ts`, reusing a known-good devnet
token if it's still live on the enclave, or deploying a fresh minimal ERC20
(via `forge create`, dockerized the same way as the host's glibc-incompatible
`cast`/`forge` binaries) otherwise. Set `E2E_ERC20_ADDRESS` to skip this and
use a specific address instead.

The suite also runs a second, isolated Playwright project (`partial-failure`)
with its own Next dev server on port 3100 and an extra bogus network id
injected into `NEXT_PUBLIC_AGGKIT_BRIDGE_APIS`, exercising the S8
partial-failure notice (`tests/bridge/partial-failure.spec.ts`) without
disturbing the shared dev server the rest of the suite uses.

### Devnet-Specific Tests

**`tests/bridge/claim-autoclaim.spec.ts`** — L1→L2-1 auto-claim
- Devnet-only (skipped in testnet mode)
- Asserts the deposit reaches Completed (CLAIMED) state via external L1ToL2BridgeDetector
- This devnet's aggkit build auto-claims such deposits within seconds (~67s observed latency)
- See the file's top comment for why autoclaim is expected behavior here

**`tests/bridge/l2-to-l2.spec.ts`** — L2-1→L2-2 auto-claim
- Devnet-only, 2-L2 mode only
- Asserts the deposit reaches Completed (CLAIMED) state via external L2ToLxBridgeDetector
- Timeout budget: `E2E_L2_TO_L2_CLAIM_TIMEOUT_MS` (300s default, see notes on certificate cadence below)
- **Certificate cadence note:** AggKit's aggsender enforces `MinimumNewCertificateInterval: 5m0s` between certificate windows. A deposit submitted just after a window closes can wait up to 5 minutes for the next one. The 300s timeout leaves **zero margin** against unlucky timing. If timeouts occur, budget 7–8 minutes instead, or keep L1 block production fast enough to stay ahead of L2 block height.

**`tests/bridge/manual-claim.spec.ts`** — L2-1→L1 manual claim
- Devnet-only, required for both single-L2 and 2-L2 enclaves
- Now funds its own L1→L2-1 top-up deposit (via `claim-autoclaim.spec.ts` flow) before testing the L2→L1 withdrawal
- This makes the spec independent of run order and other specs' side effects
- Typical latency: ~3.9–8.3 minutes until "Ready to claim" (certificate settlement + L1 info tree sync)
- **Shared wallet state note:** The E2E wallet's balance and the enclave's transaction/certificate history accumulate across test runs on the same enclave. This spec now tops up its own balance, so isolation is preserved; future specs requiring absolute balance assertions should account for this accumulation.

### E2E Specs by Mode

| Spec | Mode | Assertion |
|------|------|-----------|
| smoke | all | Page loads, wallet connects |
| token-selector | all | Token selector shows symbol + balance |
| native-bridge | all | Native token bridge works |
| erc20-approve-bridge | all | ERC20 approval + bridge works |
| claim-autoclaim | devnet | L1→L2 autoclaim reaches Completed |
| l2-to-l2 | devnet (2-L2 only) | L2→L2 autoclaim reaches Completed |
| manual-claim | devnet | L2→L1 manual claim reaches Completed |
| partial-failure | devnet | UI partial-failure notice surfaces |
| preflight | devnet | Chain sync-status, E2E wallet funded |

## Configuration

All app configuration lives in `config.json` at the project root. See [`docs/config.md`](docs/config.md) for the full guide.

## License

Licensed under the Apache License, Version 2.0. See `LICENSE`.
