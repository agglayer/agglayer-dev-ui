'use client';

import type { TransactionStatus } from '@/app/types/transaction';

import { Dropdown } from '@/app/components/ui/dropdown';
import { getTimestampForDaysAgo } from '@/app/utils/date';
import { useState } from 'react';

interface TransactionFiltersProps {
  onFilterChange: (filters: { status?: TransactionStatus; updatedSince?: number }) => void;
  disabled?: boolean;
  initialStatus?: TransactionStatus | null;
  onStatusClear?: () => void;
  onStatusChange?: (status: TransactionStatus | null) => void;
}

const DATE_PRESETS = [
  { label: 'Last 24 hours', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'All time', days: null }
] as const;

const STATUS_OPTIONS: Array<{ label: string; value: TransactionStatus | null }> = [
  { label: 'All transactions', value: null },
  { label: 'Ready to claim', value: 'READY_TO_CLAIM' },
  { label: 'Claimed', value: 'CLAIMED' },
  { label: 'Pending', value: 'BRIDGED' }
];

export const TransactionFilters = ({
  onFilterChange,
  disabled = false,
  initialStatus = null,
  onStatusClear,
  onStatusChange
}: TransactionFiltersProps) => {
  const [selectedStatus, setSelectedStatus] = useState<TransactionStatus | null>(initialStatus);
  const [selectedDays, setSelectedDays] = useState<number | null>(null);

  const handleStatusChange = (status: TransactionStatus | null) => {
    if (disabled) return;
    setSelectedStatus(status);
    onStatusChange?.(status);
    onFilterChange({
      status: status || undefined,
      updatedSince: selectedDays ? getTimestampForDaysAgo(selectedDays) : undefined
    });
  };

  const handleDateChange = (days: number | null) => {
    if (disabled) return;
    setSelectedDays(days);
    onFilterChange({
      status: selectedStatus || undefined,
      updatedSince: days ? getTimestampForDaysAgo(days) : undefined
    });
  };

  const clearStatus = () => {
    if (disabled) return;
    setSelectedStatus(null);
    onStatusClear?.();
    onFilterChange({
      updatedSince: selectedDays ? getTimestampForDaysAgo(selectedDays) : undefined
    });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="relative">
        <Dropdown
          options={STATUS_OPTIONS.map((opt) => ({ value: opt.value ?? 'all', label: opt.label }))}
          selectedValue={selectedStatus ?? undefined}
          placeholder="Status"
          clearable
          disabled={disabled}
          onClear={clearStatus}
          onSelect={(option) => handleStatusChange((option.value as TransactionStatus) || null)}
          className="min-w-35"
        />
      </div>

      <div className="relative">
        <Dropdown
          options={DATE_PRESETS.map((preset) => ({
            value: preset.days?.toString() ?? 'all',
            label: preset.label
          }))}
          selectedValue={selectedDays !== null ? selectedDays.toString() : undefined}
          placeholder="All time"
          clearable
          disabled={disabled}
          onClear={() => handleDateChange(null)}
          onSelect={(option) =>
            handleDateChange(option.value === 'all' ? null : Number(option.value))
          }
          className="min-w-35"
        />
      </div>
    </div>
  );
};
