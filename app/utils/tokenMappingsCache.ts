import { normalize } from '@/app/utils/format';
import { z } from 'zod';

// A wrapped token only exists on a network once it was claimed there for the
// first time, so "not deployed yet" is short-lived: a user can bridge and claim
// right before switching "Bridge from" to that network. A `found` entry never
// expires (the bridge never re-maps a deployed wrapped token).
export const ABSENT_TTL_MS = 60 * 1000;

const entrySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('found'), wrappedAddress: z.string(), checkedAt: z.number() }),
  z.object({ status: z.literal('absent'), checkedAt: z.number() })
]);

const cacheSchema = z.record(z.string(), entrySchema);

export type TokenMappingEntry = z.infer<typeof entrySchema>;
export type TokenMappingsCache = z.infer<typeof cacheSchema>;

export const getMappingKey = (params: {
  sourceChainId: number;
  sourceAddress: string;
  targetChainId: number;
}): string => `${params.sourceChainId}:${normalize(params.sourceAddress)}:${params.targetChainId}`;

// Stored data is untrusted (older/foreign shapes, manual edits): anything that
// does not match the schema is dropped and recomputed rather than cast.
export const parseTokenMappingsCache = (raw: unknown): TokenMappingsCache => {
  const parsed = cacheSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
};

export const isMappingEntryFresh = (params: {
  entry: TokenMappingEntry | undefined;
  now: number;
}): boolean => {
  const { entry, now } = params;
  if (!entry) return false;
  return entry.status === 'found' || now - entry.checkedAt < ABSENT_TTL_MS;
};
