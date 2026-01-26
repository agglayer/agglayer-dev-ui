import { BadgeImageFallback } from '@/app/components/ui/badgeImageFallback';
import { ArrowRight } from 'lucide-react';

interface TransactionDetailsHeaderProps {
  sourceChain?: { name: string; icon?: string };
  destChain?: { name: string; icon?: string };
  tokenLogo?: string;
  tokenSymbol: string;
  formattedAmount: string;
}

export const TransactionDetailsHeader = ({
  sourceChain,
  destChain,
  tokenLogo,
  tokenSymbol,
  formattedAmount,
}: TransactionDetailsHeaderProps) => {
  return (
    <div className="w-full rounded-xl border border-border bg-surface-muted p-5 flex flex-col items-center text-center">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-foreground">{sourceChain?.name ?? '-'}</span>
        <ArrowRight className="size-4 text-muted" />
        <span className="font-medium text-foreground">{destChain?.name ?? '-'}</span>
      </div>
      <div className="mt-4 flex items-center gap-2.5">
        {tokenLogo && <BadgeImageFallback src={tokenLogo} size="lg" fallbackText={tokenSymbol} />}
        <span className="text-3xl font-bold text-foreground">
          {formattedAmount} {tokenSymbol}
        </span>
      </div>
    </div>
  );
};
