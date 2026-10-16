// Resolves a `secretRef` (DESIGN §2.2: `{env}` or `{file}`, never an inline
// literal) to the actual secret value. Deliberately the ONLY place in
// `loadtest/` that reads `process.env`/the filesystem for a secret, so every
// other module receives an already-resolved key material (mnemonic /
// private key) and never a `secretRef` it would have to know how to read.
//
// Error messages here name the secretRef's *label* (e.g.
// "users.funder.privateKeyRef") and, for `{file}`, the file path — never the
// resolved value — so a thrown SecretResolutionError is always safe to log
// or pass through metrics/errors.ts's redactor unchanged.
import fs from 'node:fs';

import type { SecretRef } from '../config/schema';

export class SecretResolutionError extends Error {}

const FILE_MODE_MASK = 0o777;
const REQUIRED_FILE_MODE = 0o600;

const readSecretRefRaw = (ref: SecretRef, label: string): string => {
  if ('env' in ref) {
    const value = process.env[ref.env];
    if (value === undefined) {
      throw new SecretResolutionError(`${label}: environment variable "${ref.env}" is not set`);
    }
    return value;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(ref.file);
  } catch (error) {
    throw new SecretResolutionError(
      `${label}: could not stat secret file "${ref.file}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const mode = stat.mode & FILE_MODE_MASK;
  if (mode !== REQUIRED_FILE_MODE) {
    throw new SecretResolutionError(
      `${label}: secret file "${ref.file}" must have permissions 0600, found 0${mode.toString(8)} — refusing to read it`
    );
  }

  try {
    return fs.readFileSync(ref.file, 'utf8');
  } catch (error) {
    throw new SecretResolutionError(
      `${label}: could not read secret file "${ref.file}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/** A single-value secretRef (a mnemonic, a private key) — trimmed whole. */
export const resolveSecret = (ref: SecretRef, label = 'secretRef'): string =>
  readSecretRefRaw(ref, label).trim();

/**
 * A multi-value secretRef (DESIGN §2.1 `users.wallets.privateKeysRef`: "the
 * file's Nth line for user N"). Blank lines are dropped so a trailing
 * newline in the file doesn't count as an empty key.
 */
export const resolveSecretLines = (ref: SecretRef, label = 'secretRef'): string[] =>
  readSecretRefRaw(ref, label)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
