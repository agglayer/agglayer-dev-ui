import { formatTokenAmount } from './format';
import { createPublicClient, http, type Hash, type PublicClient } from 'viem';
import type { Transaction } from '@/app/types/transaction';
import { NETWORK_ID_TO_VIEM_CHAIN } from '@/app/constants/chains';
import { fromWei } from '@/app/utils/big-number';

export const formatTransactionAmount = (amount: string, decimals: number): string => {
  try {
    const humanAmount = fromWei(amount, decimals);
    return formatTokenAmount(humanAmount);
  } catch {
    return amount;
  }
};

export const isNativeToken = (address: string) => {
  return address === '0x0000000000000000000000000000000000000000';
};

const getClientForNetwork = (networkId: number): PublicClient | null => {
  const chain = NETWORK_ID_TO_VIEM_CHAIN[networkId];
  const rpcUrl = chain?.rpcUrls?.default?.http?.[0];
  if (!chain || !rpcUrl) return null;

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
};

const getTransactionFee = async (client: PublicClient, hash: string): Promise<bigint | null> => {
  try {
    const receipt = await client.getTransactionReceipt({ hash: hash as Hash });
    const gasPrice = receipt.effectiveGasPrice;
    if (!gasPrice) return null;
    return receipt.gasUsed * gasPrice;
  } catch (error) {
    console.error('Failed to fetch transaction fee', { hash, error });
    return null;
  }
};

export const getTransactionFeesForBridgeAndClaim = async (tx: Transaction) => {
  const sourceClient = getClientForNetwork(tx.sourceNetwork);
  const destClient = tx.claimTransactionHash ? getClientForNetwork(tx.destinationNetwork) : null;

  const [bridgeFeeWei, claimFeeWei] = await Promise.all([
    sourceClient ? getTransactionFee(sourceClient, tx.transactionHash) : Promise.resolve(null),
    tx.claimTransactionHash && destClient
      ? getTransactionFee(destClient, tx.claimTransactionHash)
      : Promise.resolve(null),
  ]);

  return {
    bridgeFeeWei,
    claimFeeWei,
  };
};
