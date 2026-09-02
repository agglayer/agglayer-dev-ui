'use client';

import type { ReactNode } from 'react';

import { Button } from '@/app/components/ui/button';
import { Spinner } from '@/app/components/ui/spinner';
import { initAppConfig } from '@/app/config';
import { fetchAppConfig } from '@/app/configLoader';
import { useEffect, useState } from 'react';

// Outermost node of app/providers.tsx (design.md §3). Fetches /config.json
// once per mount (plus once per explicit Retry) and populates app/config.ts's
// module store *before* any child renders, so every accessor
// (getExternalLinks, getAppModeConfig, ...) is safe to call unconditionally
// once children are reached.
//
// The first render on both server-prerender and client-hydration is always
// `pending` -- no config read, no `typeof window` branch, no Date.now()/
// Math.random() -- so there is no hydration mismatch under `output: 'export'`
// (design.md §3.5). The fetch only ever happens in an effect, which never
// runs during prerender.
type ConfigLoadState =
  | { status: 'pending' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

const toConfigErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const ConfigLoadingScreen = () => (
  <div
    data-test-id="app-config-loading"
    className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-background"
  >
    <Spinner size="xl" />
    <p className="text-sm text-grey">Loading configuration…</p>
  </div>
);

interface ConfigErrorScreenProps {
  message: string;
  onRetry: () => void;
}

export const ConfigErrorScreen = ({ message, onRetry }: ConfigErrorScreenProps) => (
  <div
    data-test-id="app-config-error"
    className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-background px-4 text-center"
  >
    <h1 className="text-xl font-bold">Configuration failed to load</h1>
    <pre className="max-w-xl whitespace-pre-wrap break-words text-left text-sm text-grey">
      {message}
    </pre>
    <Button onClick={onRetry} data-test-id="app-config-retry">
      Retry
    </Button>
  </div>
);

export const AppConfigGate = ({ children }: { readonly children: ReactNode }) => {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ConfigLoadState>({ status: 'pending' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'pending' });

    fetchAppConfig()
      .then((configJson) => {
        if (cancelled) return;
        // Populate the store BEFORE flipping to 'ready' so every accessor is
        // safe to call the instant children render.
        initAppConfig(configJson);
        setState({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: toConfigErrorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state.status === 'pending') return <ConfigLoadingScreen />;
  if (state.status === 'error') {
    return <ConfigErrorScreen message={state.message} onRetry={() => setAttempt((n) => n + 1)} />;
  }

  return <>{children}</>;
};
