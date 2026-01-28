'use client';

import { useMemo, type ReactNode } from 'react';
import { cn } from '@/app/utils/common';
import { bn } from '@/app/utils/bigNumber';

type QuickAction = {
  label: string;
  value: string;
};

interface AmountInputProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  balanceText?: string;
  tokenLabel?: string;
  tokenIcon?: ReactNode;
  onClick?: () => void;
  quickActions?: QuickAction[];
  disabled?: boolean;
  className?: string;
  maxDecimals?: number;
  tokenButtonTestId?: string;
}

export const AmountInput = ({
  label,
  value,
  onChange,
  placeholder = '0',
  balanceText,
  tokenLabel,
  tokenIcon,
  onClick,
  quickActions = [],
  disabled,
  className,
  maxDecimals = 18,
  tokenButtonTestId,
}: AmountInputProps) => {
  const decimalsLimit = Math.max(0, Math.trunc(maxDecimals));
  const decimalRegex = useMemo(
    () => new RegExp(decimalsLimit === 0 ? '^(?!0\\d|\\.)\\d*$' : `^(?!0\\d|\\.)\\d*(?:\\.\\d{0,${decimalsLimit}})?$`),
    [decimalsLimit],
  );

  const handleChange = (inputValue: string) => {
    // Allow empty string
    if (inputValue === '') {
      onChange?.('');
      return;
    }

    // Limit decimals and prevent invalid number formats
    if (!decimalRegex.test(inputValue)) {
      return;
    }

    // Validate that it's a valid BigNumber
    try {
      bn(inputValue);
      onChange?.(inputValue);
    } catch {
      // Invalid number, don't update
    }
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {label && <span className="text-sm font-medium text-muted">{label}</span>}

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
          onChange={(e) => handleChange(e.target.value)}
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
            onClick={onClick}
            disabled={disabled}
            data-test-id={tokenButtonTestId}
            className={cn(
              'flex items-center gap-2 rounded-xl border border-border bg-surface-muted px-3 py-2 text-sm font-semibold cursor-pointer',
              disabled ? 'cursor-not-allowed opacity-70' : 'hover:border-blue hover:bg-surface transition-colors',
            )}
          >
            {tokenIcon}
            <span>{tokenLabel}</span>
          </button>
        )}
      </div>

      {(balanceText || quickActions.length > 0) && (
        <div className="flex items-center justify-between text-sm">
          {balanceText ? <span className="text-grey">Balance: {balanceText}</span> : <span />}
          {quickActions.length > 0 && (
            <div className="flex flex-wrap gap-2 justify-end">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => onChange(action.value)}
                  disabled={disabled}
                  className={cn(
                    'rounded-lg border border-border bg-surface px-3 py-1 text-xs font-semibold text-muted cursor-pointer',
                    disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-blue hover:text-black',
                  )}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
