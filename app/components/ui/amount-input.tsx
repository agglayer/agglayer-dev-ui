'use client';

import type { ReactNode } from 'react';
import { cn } from '@/app/utils/common';

type QuickAction = {
  label: string;
  value: string;
};

type AmountInputProps = {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  balanceText?: string;
  tokenLabel?: string;
  tokenIcon?: ReactNode;
  onTokenClick?: () => void;
  quickActions?: QuickAction[];
  disabled?: boolean;
  className?: string;
};

export const AmountInput = ({
  label,
  value,
  onChange,
  placeholder = '0',
  balanceText,
  tokenLabel,
  tokenIcon,
  onTokenClick,
  quickActions = [],
  disabled,
  className,
}: AmountInputProps) => {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between text-sm">
        {label && <span className="font-medium text-muted">{label}</span>}
        {balanceText && <span className="text-grey">Balance: {balanceText}</span>}
      </div>

      <div
        className={cn(
          'flex items-center gap-4 rounded-2xl border border-border bg-surface px-4 py-3 shadow-xs',
          disabled ? 'cursor-not-allowed bg-surface-muted opacity-70' : 'hover:border-slate-300',
        )}
      >
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'w-full bg-transparent text-2xl font-semibold leading-none outline-none placeholder:text-grey',
            disabled && 'cursor-not-allowed',
          )}
        />
        {tokenLabel && (
          <button
            type="button"
            onClick={onTokenClick}
            disabled={disabled}
            className={cn(
              'flex items-center gap-2 rounded-xl border border-border bg-surface-muted px-3 py-2 text-sm font-semibold cursor-pointer',
              disabled ? 'cursor-not-allowed opacity-70' : 'hover:border-slate-300 hover:bg-surface transition-colors',
            )}
          >
            {tokenIcon}
            <span>{tokenLabel}</span>
          </button>
        )}
      </div>

      {quickActions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {quickActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => onChange(action.value)}
              disabled={disabled}
              className={cn(
                'rounded-lg border border-border bg-surface px-3 py-1 text-xs font-semibold text-muted cursor-pointer',
                disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-slate-300 hover:text-black',
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
