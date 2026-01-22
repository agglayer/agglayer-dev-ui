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

export const formatDuration = (minutes: number): string => {
  if (minutes < 60) {
    return `~${minutes} min${minutes !== 1 ? 's' : ''}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;

  if (remainingMins === 0) {
    return `~${hours} hour${hours !== 1 ? 's' : ''}`;
  }

  return `~${hours}h ${remainingMins}m`;
};

export type ETAStatus = 'pending' | 'grace' | 'delayed';

export const getETAStatus = (timestampSeconds: number, etaMinutes: number): { status: ETAStatus; message: string } => {
  const now = Date.now();
  const transactionTime = timestampSeconds * 1000;
  const expectedArrival = transactionTime + etaMinutes * 60 * 1000;
  const gracePeriodEnd = expectedArrival + 10 * 60 * 1000;

  const remainingMs = expectedArrival - now;
  const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));

  if (remainingMs > 0) {
    return {
      status: 'pending',
      message: `Your funds will arrive in ${formatDuration(remainingMinutes).replace('~', '')}`,
    };
  }

  if (now < gracePeriodEnd) {
    return {
      status: 'grace',
      message: 'Your funds will arrive soon',
    };
  }

  return {
    status: 'delayed',
    message: "Taking longer than expected, don't worry your funds are safe",
  };
};
