export const isValidEthereumAddress = (address: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(address);

export const isSameAddress = (address1: string | undefined, address2: string | undefined): boolean => {
  if (!address1 || !address2) return false;
  return address1.trim().toLowerCase() === address2.trim().toLowerCase();
};

export const shortenAddress = (address: string, chars = 4): string => {
  if (!address) return '';
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
};
