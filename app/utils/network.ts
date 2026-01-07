export const isTestnetChain = (chainId: number): boolean => {
  const testnetChains = [
    11155111,
    80002,
  ];

  return testnetChains.includes(chainId);
};
