export const DEFAULT_ACTIVITY_PAGE_SIZE = 20;
// The tracker rejects anything above this (see the SDK's getActivity).
const MAX_ACTIVITY_PAGE_SIZE = 200;

// A missing, non-numeric or out-of-range value falls back to the default
// rather than failing the build: this only exists to ease local testing of
// pagination with a tiny page.
export const parseActivityPageSize = (raw: string | undefined): number => {
  const value = Number(raw?.trim());
  return Number.isInteger(value) && value >= 1 && value <= MAX_ACTIVITY_PAGE_SIZE
    ? value
    : DEFAULT_ACTIVITY_PAGE_SIZE;
};

// Build-time override (Next inlines NEXT_PUBLIC_* into the bundle, so this has
// no effect in a prebuilt container image).
export const ACTIVITY_PAGE_SIZE = parseActivityPageSize(process.env.NEXT_PUBLIC_ACTIVITY_PAGE_SIZE);
