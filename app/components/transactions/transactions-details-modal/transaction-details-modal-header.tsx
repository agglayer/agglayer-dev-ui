import { BadgeImageFallback } from '@/app/components/ui/badge-image-fallback';
import { ArrowRight } from 'lucide-react';

interface TxDetailsHeaderProps {
  sourceChain?: { name: string; icon?: string };
  destChain?: { name: string; icon?: string };
  tokenLogo?: string;
  tokenSymbol: string;
  formattedAmount: string;
}

export const TxDetailsHeader = ({
  sourceChain,
  destChain,
  tokenLogo,
  tokenSymbol,
  formattedAmount,
}: TxDetailsHeaderProps) => {
  return (
    <div className="w-full rounded-xl border border-border bg-surface-muted px-4 py-4 shadow-xs">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted/80">From</div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            {sourceChain?.icon && (
              <BadgeImageFallback
                src={sourceChain.icon}
                size="sm"
                fallbackText={sourceChain.name}
                className="shrink-0"
              />
            )}
            <span className="truncate font-semibold text-black">{sourceChain?.name ?? '-'}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-border" />
          <span className="h-px w-12 bg-border" />
          <ArrowRight className="size-6 text-muted" />
          <span className="h-px w-12 bg-border" />
          <span className="h-2 w-2 rounded-full bg-border" />
        </div>
        <div className="min-w-0 flex-1 text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted/80">To</div>
          <div className="mt-1 flex min-w-0 items-center justify-end gap-2">
            <span className="truncate font-semibold text-black">{destChain?.name ?? '-'}</span>
            {destChain?.icon && (
              <BadgeImageFallback src={destChain.icon} size="sm" fallbackText={destChain.name} className="shrink-0" />
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-center gap-2">
        {tokenLogo && <BadgeImageFallback src={tokenLogo} size="md" fallbackText={tokenSymbol} />}
        <div className="text-2xl font-bold text-black">
          {formattedAmount} {tokenSymbol}
        </div>
      </div>
    </div>
  );
};
