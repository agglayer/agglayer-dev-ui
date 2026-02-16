'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { loadRuntimeConfig } from '@/app/config';

export function ConfigLoader({ children }: { children: ReactNode }) {
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRuntimeConfig()
      .then(() => setIsConfigLoaded(true))
      .catch((err) => {
        console.error('Failed to load config:', err);
        setError(err.message || 'Failed to load configuration');
      });
  }, []);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">Configuration Error</h1>
          <p className="mt-2 text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!isConfigLoaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading configuration...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}