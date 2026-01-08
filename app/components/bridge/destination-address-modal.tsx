import { Alert } from '@/app/components/ui/alert';
import { Button } from '@/app/components/ui/button';
import { Checkbox } from '@/app/components/ui/checkbox';
import { Modal } from '@/app/components/ui/modal';
import { TextInput } from '@/app/components/ui/text-input';
import { isValidEthereumAddress } from '@/app/utils/address';
import { cn } from '@/app/utils/common';
import { useState } from 'react';

interface DestinationAddressModalProps {
  open: boolean;
  onClose: () => void;
  onChangeAddress: (address: string) => void;
}

export const DestinationAddressModal = ({ open, onClose, onChangeAddress }: DestinationAddressModalProps) => {
  const [inputAddress, setInputAddress] = useState('');
  const [isConfirmed, setIsConfirmed] = useState(false);

  const trimmedAddress = inputAddress.trim();
  const isValid = isValidEthereumAddress(trimmedAddress);

  const handleSave = () => {
    if (!isValid) return;
    onChangeAddress(trimmedAddress);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Destination Address">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col">
          <TextInput
            placeholder="Please enter destination address"
            value={inputAddress}
            onChange={setInputAddress}
            isError={!isValid && inputAddress.length > 0}
          />
          <div
            className={cn(
              'flex items-center gap-2',
              !isValid && inputAddress.length > 0 ? 'justify-between' : 'justify-end',
            )}
          >
            {!isValid && inputAddress.length > 0 && <p className="text-sm text-red">Please enter a valid address</p>}
          </div>
        </div>

        <Alert
          title="Ensure address is correct"
          message="Bridged tokens will be received at the above-mentioned address."
        />
        <Checkbox
          checked={isConfirmed}
          onCheckedChange={setIsConfirmed}
          label="I have double-checked the address is correct. Any tokens sent to an incorrect address will be unrecoverable."
          labelClassName="text-xs text-grey"
          disabled={!isValid || inputAddress.length === 0}
        />

        <Button disabled={!isValid || !isConfirmed} onClick={handleSave}>
          Save
        </Button>
      </div>
    </Modal>
  );
};
