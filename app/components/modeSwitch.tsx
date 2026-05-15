'use client';

import type { AppMode } from '@/app/types/appMode';

import { APP_MODE_CONFIG } from '@/app/config';
import { useAppMode } from '@/app/context/appMode';
import { Code } from 'lucide-react';
import { useMemo } from 'react';

type ModeOption = {
  value: AppMode;
  label: string;
};

export const ModeSwitch = () => {
  const { mode, setMode, enabledModes } = useAppMode();

  const options = useMemo<ModeOption[]>(
    () =>
      enabledModes
        .filter((value) => value !== mode)
        .map((value) => ({
          value,
          label: APP_MODE_CONFIG[value].label
        })),
    [enabledModes, mode]
  );

  if (options.length === 0) return null;

  return (
    <div className="space-y-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => setMode(option.value)}
          className="flex items-center gap-3 px-3 py-2 text-black md:hover:bg-surface-muted rounded-lg cursor-pointer transition-colors w-full"
        >
          <Code size={20} />
          <span>Switch to {option.label}</span>
        </button>
      ))}
    </div>
  );
};
