export const formatDate = (timestampSeconds: number): string => {
  const date = new Date(timestampSeconds * 1000);
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
};

export const formatDateTime = (timestampSeconds: number): string => {
  const date = new Date(timestampSeconds * 1000);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const getTimestampForDaysAgo = (days: number): number => {
  const now = Date.now();
  return now - days * 24 * 60 * 60 * 1000;
};

export const groupTransactionsByDate = <T extends { timestamp: number }>(transactions: T[]): Record<string, T[]> => {
  return transactions.reduce(
    (groups, tx) => {
      const date = formatDate(tx.timestamp);
      if (!groups[date]) {
        groups[date] = [];
      }
      groups[date].push(tx);
      return groups;
    },
    {} as Record<string, T[]>,
  );
};
