import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIVITY_PAGE_SIZE, parseActivityPageSize } from './activity';

describe('parseActivityPageSize', () => {
  it('uses a valid override', () => {
    expect(parseActivityPageSize('2')).toBe(2);
    expect(parseActivityPageSize(' 200 ')).toBe(200);
  });

  it('falls back to the default when unset, invalid or out of range', () => {
    for (const raw of [undefined, '', 'abc', '0', '-1', '1.5', '201']) {
      expect(parseActivityPageSize(raw)).toBe(DEFAULT_ACTIVITY_PAGE_SIZE);
    }
  });
});
