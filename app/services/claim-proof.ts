import type { Hex } from 'viem';
import { AppMode } from '@/app/types/app-mode';
import { getBridgeHubApiBaseUrl } from '@/app/utils/app-mode';

export type ClaimProof = {
  proof_local_exit_root: Hex[];
  proof_rollup_exit_root: Hex[];
  l1_info_tree_leaf: {
    block_num: number;
    block_pos: number;
    l1_info_tree_index: number;
    previous_block_hash: string;
    timestamp: number;
    mainnet_exit_root: Hex;
    rollup_exit_root: Hex;
    global_exit_root: Hex;
    hash: Hex;
  };
};

type ClaimProofResponse = {
  status: 'success' | 'error';
  data?: ClaimProof;
  error?: string;
};

const buildClaimProofUrl = (params: {
  mode: AppMode;
  sourceNetworkId: number;
  leafIndex: number;
  depositCount: number;
}): string => {
  const url = new URL(`${getBridgeHubApiBaseUrl(params.mode)}/claim-proof`);
  url.searchParams.set('sourceNetworkId', params.sourceNetworkId.toString());
  url.searchParams.set('leafIndex', params.leafIndex.toString());
  url.searchParams.set('depositCount', params.depositCount.toString());
  return url.toString();
};

export const fetchClaimProof = async (params: {
  mode: AppMode;
  sourceNetworkId: number;
  leafIndex: number;
  depositCount: number;
}): Promise<ClaimProof> => {
  const url = buildClaimProofUrl(params);
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`CLAIM_PROOF_${res.status}: ${msg || 'Request failed'}`);
  }

  const json: ClaimProofResponse = await res.json();
  if (json.status !== 'success' || !json.data) {
    throw new Error(json.error || 'CLAIM_PROOF_INVALID_RESPONSE');
  }

  return json.data;
};
