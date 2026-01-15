// Global flag for cross-page aggressive refetch triggers
// Used when navigating from bridge success to transactions page
let shouldRefetchAggressively = false;

export const triggerAggressiveRefetch = () => {
  shouldRefetchAggressively = true;
};

export const consumeAggressiveRefetch = () => {
  const value = shouldRefetchAggressively;
  shouldRefetchAggressively = false;
  return value;
};
