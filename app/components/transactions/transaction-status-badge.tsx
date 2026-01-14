import { CheckCircle, Loader2 } from 'lucide-react';
import type { TransactionStatus } from '@/app/types/transaction';
import { cn } from '@/app/utils/common';

interface TransactionStatusBadgeProps {
  status: TransactionStatus;
  className?: string;
}

const STATUS_CONFIG: Record<
  TransactionStatus,
  { label: string; icon: React.ReactNode; variant: 'success' | 'warning' | 'info' | 'pending' }
> = {
  CLAIMED: {
    label: 'Completed',
    icon: <CheckCircle size={16} />,
    variant: 'success',
  },
  READY_TO_CLAIM: {
    label: 'Ready to claim',
    icon: <CheckCircle size={16} />,
    variant: 'info',
  },
  LEAF_INCLUDED: {
    label: 'Pending',
    icon: <Loader2 size={16} className="animate-spin" />,
    variant: 'pending',
  },
  BRIDGED: {
    label: 'Pending',
    icon: <Loader2 size={16} className="animate-spin" />,
    variant: 'warning',
  },
};

const VARIANT_STYLES = {
  success: 'bg-green-light text-green border-green',
  info: 'bg-blue-subtle text-blue border-blue',
  warning: 'bg-orange/10 text-orange border-orange/20',
  pending: 'bg-grey-light text-black border-border',
};

export const TransactionStatusBadge = ({ status, className }: TransactionStatusBadgeProps) => {
  const config = STATUS_CONFIG[status];
  const variantStyle = VARIANT_STYLES[config.variant];

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold',
        variantStyle,
        className,
      )}
    >
      {config.icon}
      <span>{config.label}</span>
    </div>
  );
};
