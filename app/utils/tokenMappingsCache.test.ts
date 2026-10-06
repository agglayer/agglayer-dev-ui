import { describe, expect, it } from 'vitest';

import {
  ABSENT_TTL_MS,
  getMappingKey,
  isMappingEntryFresh,
  parseTokenMappingsCache
} from './tokenMappingsCache';

describe('getMappingKey', () => {
  it('is case-insensitive on the address and distinguishes source and target chains', () => {
    const base = { sourceChainId: 1, sourceAddress: '0xABc', targetChainId: 2 };
    expect(getMappingKey(base)).toBe('1:0xabc:2');
    expect(getMappingKey({ ...base, sourceAddress: '0xabc' })).toBe(getMappingKey(base));
    expect(getMappingKey({ ...base, targetChainId: 3 })).not.toBe(getMappingKey(base));
  });
});

describe('parseTokenMappingsCache', () => {
  it('keeps well-formed entries', () => {
    const raw = {
      '1:0xabc:2': { status: 'found', wrappedAddress: '0xdef', checkedAt: 10 },
      '1:0xabc:3': { status: 'absent', checkedAt: 20 }
    };
    expect(parseTokenMappingsCache(raw)).toEqual(raw);
  });

  it.each([null, 'text', 42, [], { k: { status: 'found' } }, { k: { status: 'other' } }])(
    'falls back to an empty cache for malformed data (%j)',
    (raw) => {
      expect(parseTokenMappingsCache(raw)).toEqual({});
    }
  );
});

describe('isMappingEntryFresh', () => {
  const now = 1_000_000;

  it('treats a missing entry as stale', () => {
    expect(isMappingEntryFresh({ entry: undefined, now })).toBe(false);
  });

  it('never expires a found entry', () => {
    const entry = { status: 'found', wrappedAddress: '0xdef', checkedAt: 0 } as const;
    expect(isMappingEntryFresh({ entry, now })).toBe(true);
  });

  it('expires an absent entry once the TTL has passed', () => {
    const entry = { status: 'absent', checkedAt: now - ABSENT_TTL_MS + 1 } as const;
    expect(isMappingEntryFresh({ entry, now })).toBe(true);
    expect(isMappingEntryFresh({ entry, now: now + 1 })).toBe(false);
  });
});
