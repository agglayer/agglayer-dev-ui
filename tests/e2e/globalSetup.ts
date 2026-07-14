import type { FullConfig } from '@playwright/test';
import type { Address } from 'viem';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEVNET_KNOWN_ERC20_CANDIDATE,
  E2E_BACKEND_MODE,
  E2E_PRIVATE_KEY,
  E2E_WALLET_ADDRESS
} from '@/app/constants/e2e';
import { normalizeEnvValue } from '@/app/utils/e2eEnv';
import { getE2EFromChain, getE2EFromChainRpcUrl } from '@/tests/e2e/chainRpc';
import { createPublicClient, erc20Abi, http, isAddress } from 'viem';

// A minimal, self-mintable ERC20 -- deployed fresh via `forge create` (docker
// wrapper, same pattern S12 manual validation used for the host's
// glibc-incompatible cast/forge) only when neither an explicit
// E2E_ERC20_ADDRESS override nor the known S12 devnet token
// (app/constants/e2e.ts DEVNET_KNOWN_ERC20_CANDIDATE) is still live on this
// enclave. Standard erc20Abi-compatible surface (name/symbol/decimals/
// balanceOf/allowance/approve/transfer/transferFrom) -- enough for the
// bridge's approve+bridgeAsset flow.
const E2E_TOKEN_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract E2EToken {
    string public name = "Agglayer E2E Token";
    string public symbol = "E2E";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
`;

const DOCKER_FOUNDRY_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
// 1000 tokens at 18 decimals -- comfortably more than E2E_ERC20_BRIDGE_AMOUNT
// will ever bridge across a full test run.
const INITIAL_SUPPLY = '1000000000000000000000';

const runForgeCreate = (workDir: string, rpcUrl: string, privateKey: string): string => {
  // NOTE: no `--skip-simulation`. foundry:latest has moved to 1.7.x, whose
  // `forge create` no longer accepts that flag; its variadic
  // `--constructor-args` then swallows the stray token and forge aborts with
  // "Constructor argument count mismatch: expected 1 but got 2". Letting the
  // deploy simulate before broadcasting is harmless on this fast devnet L1.
  const forgeCmd =
    `cd /workspace && forge create src/E2EToken.sol:E2EToken ` +
    `--rpc-url ${rpcUrl} --private-key ${privateKey} --broadcast ` +
    `--constructor-args ${INITIAL_SUPPLY}`;

  // Same docker-wrapped foundry invocation S12 manual validation established
  // for this host (host `cast`/`forge` are glibc-incompatible -- Debian 11,
  // glibc 2.31, binaries need 2.32+). The image's entrypoint is a bare
  // `/bin/sh -c` with no default args, so the whole command must be a single
  // quoted string, not split across argv entries.
  //
  // Run the container as the *host* uid:gid (not the image's default uid 1000
  // `foundry` user): fs.mkdtempSync creates $workDir mode 0700 owned by the
  // host user, so a different in-container uid can't even traverse into the
  // bind-mounted /workspace ("cd: can't cd to /workspace" / "Permission
  // denied"). Matching uids also means forge's output + solc cache are written
  // back owned by the host user, so the finally-block fs.rmSync cleanup works.
  // HOME=/workspace gives forge a writable home for its svm/solc install.
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  return execFileSync(
    'sudo',
    [
      'docker',
      'run',
      '--rm',
      '--network',
      'host',
      '--user',
      `${uid}:${gid}`,
      '-e',
      'HOME=/workspace',
      '-v',
      `${workDir}:/workspace`,
      DOCKER_FOUNDRY_IMAGE,
      forgeCmd
    ],
    { encoding: 'utf8' }
  );
};

const deployE2EErc20 = (rpcUrl: string, privateKey: string): Address => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-erc20-'));
  try {
    fs.writeFileSync(path.join(workDir, 'foundry.toml'), '[profile.default]\nsrc = "src"\nout = "out"\n');
    fs.mkdirSync(path.join(workDir, 'src'));
    fs.writeFileSync(path.join(workDir, 'src', 'E2EToken.sol'), E2E_TOKEN_SOURCE);

    const output = runForgeCreate(workDir, rpcUrl, privateKey);
    const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
    if (!match) {
      throw new Error(
        `E2E global setup: could not parse a deployed address from forge create's output:\n${output}`
      );
    }
    return match[1] as Address;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

/**
 * Ensures a usable devnet ERC20 exists for tests/bridge/erc20-approve-bridge.spec.ts
 * before any spec file runs, and sets process.env.E2E_ERC20_ADDRESS so
 * app/constants/e2e.ts resolves it (Playwright's worker processes inherit
 * process.env as set by globalSetup at the point workers are forked -- the
 * same idiom Playwright's own docs use for injecting an auth token from
 * globalSetup into tests).
 *
 * No-op in testnet mode: that mode uses the fixed, always-funded Sepolia
 * USDC address (app/constants/e2e.ts TESTNET_ERC20_ADDRESS internal
 * default), which needs no bring-up.
 */
const globalSetup = async (_config: FullConfig): Promise<void> => {
  if (E2E_BACKEND_MODE !== 'devnet') {
    return;
  }

  if (!E2E_PRIVATE_KEY || !E2E_WALLET_ADDRESS) {
    throw new Error('E2E global setup: E2E_PRIVATE_KEY did not resolve to a funded wallet.');
  }
  const privateKey = E2E_PRIVATE_KEY;
  const walletAddress = E2E_WALLET_ADDRESS;

  const chain = getE2EFromChain();
  const rpcUrl = getE2EFromChainRpcUrl();
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const isUsable = async (address: Address): Promise<boolean> => {
    const bytecode = await publicClient.getCode({ address }).catch(() => undefined);
    if (!bytecode || bytecode === '0x') return false;
    const balance = await publicClient
      .readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress] })
      .catch(() => BigInt(0));
    return balance > BigInt(0);
  };

  const explicitOverride = normalizeEnvValue(process.env.E2E_ERC20_ADDRESS);
  if (explicitOverride) {
    if (!isAddress(explicitOverride)) {
      throw new Error(`E2E global setup: E2E_ERC20_ADDRESS "${explicitOverride}" is not a valid address.`);
    }
    if (!(await isUsable(explicitOverride))) {
      throw new Error(
        `E2E global setup: E2E_ERC20_ADDRESS override ${explicitOverride} has no bytecode, or a ` +
          `zero balance for the funded E2E wallet, on chain ${chain.id} (${rpcUrl}).`
      );
    }
    process.stdout.write(`[e2e globalSetup] Using explicit E2E_ERC20_ADDRESS override: ${explicitOverride}\n`);
    return;
  }

  if (await isUsable(DEVNET_KNOWN_ERC20_CANDIDATE)) {
    process.env.E2E_ERC20_ADDRESS = DEVNET_KNOWN_ERC20_CANDIDATE;
    process.stdout.write(
      `[e2e globalSetup] Reusing known devnet ERC20 ${DEVNET_KNOWN_ERC20_CANDIDATE} (still live, funded).\n`
    );
    return;
  }

  process.stdout.write(
    '[e2e globalSetup] No usable devnet ERC20 found (enclave likely recreated) -- deploying a fresh one...\n'
  );
  const deployed = deployE2EErc20(rpcUrl, privateKey);
  if (!(await isUsable(deployed))) {
    throw new Error(`E2E global setup: freshly deployed ERC20 ${deployed} is not usable after deployment.`);
  }
  process.env.E2E_ERC20_ADDRESS = deployed;
  process.stdout.write(`[e2e globalSetup] Deployed fresh devnet ERC20 at ${deployed}\n`);
};

// Playwright's `globalSetup` config option requires the target module's
// default export to be the setup function -- an external API constraint,
// not a style choice.
// eslint-disable-next-line import-x/no-default-export
export default globalSetup;
