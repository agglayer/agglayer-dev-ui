'use client';

import { useState } from 'react';
import { Modal } from '@/app/components/ui/modal';
import type { Token } from '@/app/types/token';
import { TokenSelectorListView } from '@/app/components/bridge/token-selector-list-view';
import { ManageTokensView } from '@/app/components/bridge/token-selector-manage-view';
import { useTokens } from '@/app/context/token';

interface TokenSelectorProps {
  open: boolean;
  onClose: () => void;
  selectedToken?: Token;
  onSelect: (token: Token) => void;
  chainId: number;
  chainName?: string;
}

export const TokenSelector = ({ open, onClose, selectedToken, onSelect, chainId, chainName }: TokenSelectorProps) => {
  const { listTokens, customTokens, addCustomToken, removeCustomToken } = useTokens();
  const [search, setSearch] = useState('');
  const [customTokenAddress, setCustomTokenAddress] = useState('');
  const [mode, setMode] = useState<'select' | 'manage'>('select');

  const tokens = listTokens(chainId);

  const handleClose = () => {
    setMode('select');
    setCustomTokenAddress('');
    setSearch('');
    onClose();
  };

  const handleAddCustomToken = (token: Token) => {
    addCustomToken(token);
    setCustomTokenAddress('');
  };

  const goToManage = () => {
    setCustomTokenAddress('');
    setMode('manage');
  };

  const goToSelect = () => {
    setMode('select');
  };

  const isSelectMode = mode === 'select';

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={isSelectMode ? `Select token${chainName ? ` on ${chainName}` : ''}` : 'Manage tokens'}
    >
      <div className="flex flex-col gap-4">
        {isSelectMode ? (
          <TokenSelectorListView
            tokens={tokens}
            selectedToken={selectedToken}
            chainName={chainName}
            search={search}
            onSearchChange={setSearch}
            onSelect={(token) => {
              onSelect(token);
              handleClose();
            }}
            onManageTokens={goToManage}
          />
        ) : (
          <ManageTokensView
            chainId={chainId}
            chainName={chainName}
            customTokenAddress={customTokenAddress}
            onCustomTokenAddressChange={setCustomTokenAddress}
            onBack={goToSelect}
            onAddCustomToken={handleAddCustomToken}
            onRemoveCustomToken={removeCustomToken}
            customTokens={customTokens}
          />
        )}
      </div>
    </Modal>
  );
};
