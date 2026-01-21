'use client';

import { ReactNode, useEffect, useState } from 'react';
import { Clock, AlertCircle } from 'lucide-react';
import { getETAStatus, type ETAStatus } from '@/app/utils/date';
import { cn } from '@/app/utils/common';

interface TransactionETAProps {
  timestamp: number;
  etaMinutes: number;
  className?: string;
}

const iconMap: Record<ETAStatus, ReactNode> = {
  pending: <Clock size={14} />,
  grace: <Clock size={14} />,
  delayed: <AlertCircle size={14} />,
};

const colorMap: Record<ETAStatus, string> = {
  pending: 'text-blue',
  grace: 'text-blue',
  delayed: 'text-orange',
};

export const TransactionETA = ({ timestamp, etaMinutes, className }: TransactionETAProps) => {
  const [etaInfo, setEtaInfo] = useState(() => getETAStatus(timestamp, etaMinutes));

  useEffect(() => {
    const interval = setInterval(() => {
      setEtaInfo(getETAStatus(timestamp, etaMinutes));
    }, 60_000);

    return () => clearInterval(interval);
  }, [timestamp, etaMinutes]);

  return (
    <div className={cn('flex items-center gap-1.5', colorMap[etaInfo.status], className)}>
      {iconMap[etaInfo.status]}
      <span>{etaInfo.message}</span>
    </div>
  );
};
