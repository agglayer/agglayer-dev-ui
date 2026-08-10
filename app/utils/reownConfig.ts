// Pure helpers for the Reown/AppKit bootstrap in app/context/wallet.tsx,
// split out here so the placeholder-id detection and metadata.url derivation
// can be unit tested without pulling in @reown/appkit or a DOM.

// The production canonical URL, used both as the SSR-safe fallback for
// metadata.url (console-triage.md row 7) and as the shape reference for
// what a "real" WalletConnect Cloud project id looks like (it is not a
// placeholder).
export const PRODUCTION_METADATA_URL = 'https://dev-ui.agglayer.dev/';

// .env.example / .env.local both ship this literal as the checked-in
// placeholder (with a TODO to replace it with a real
// https://cloud.reown.com project id). Treat it, and an empty/whitespace
// value, as "no real project id configured" -- see console-triage.md rows
// 3-6 (S8 plan decision: degrade gracefully rather than requiring a real id).
const PLACEHOLDER_PROJECT_ID = 'YOUR_PROJECT_ID_HERE';

export const isPlaceholderProjectId = (projectId: string | undefined | null): boolean => {
  const trimmed = (projectId ?? '').trim();
  return trimmed === '' || trimmed === PLACEHOLDER_PROJECT_ID;
};

// metadata.url should describe wherever the app is actually being served
// from -- hardcoding the production domain trips AppKit/WalletConnect's own
// "configured metadata.url differs from the actual page url" warning on
// every local/dev/preview origin (console-triage.md row 7). window.location
// is only available client-side; SSR/build-time evaluation (and any
// environment where origin can't be read) falls back to the production
// domain, which is always a truthful description of the deployed app.
export const resolveMetadataUrl = (origin?: string | null): string => {
  const resolvedOrigin =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
  const trimmed = resolvedOrigin?.trim();
  return trimmed ? trimmed : PRODUCTION_METADATA_URL;
};
