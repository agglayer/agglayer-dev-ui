'use client';

import { useMemo } from 'react';
import { Code } from 'lucide-react';
import { useAppMode } from '@/app/context/app-mode';
import { AppMode } from '@/app/types/app-mode';
import { APP_MODE_CONFIG } from '@/app/config';

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
          label: APP_MODE_CONFIG[value].label,
        })),
    [enabledModes, mode],
  );

  if (options.length === 0) return null;

  return (
    <div className="space-y-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => setMode(option.value)}
          className="flex items-center gap-3 px-3 py-2 text-muted hover:bg-surface-muted hover:text-black rounded-lg cursor-pointer transition-colors w-full"
        >
          <Code size={20} />
          <span className="font-medium">Switch to {option.label}</span>
        </button>
      ))}
    </div>
  );
};
