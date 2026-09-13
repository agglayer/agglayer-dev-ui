import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSecret, resolveSecretLines, SecretResolutionError } from './secrets';

const ENV_VAR = 'LOADTEST_SECRETS_TEST_VAR';

afterEach(() => {
  delete process.env[ENV_VAR];
});

describe('resolveSecret — {env}', () => {
  it('resolves and trims an environment variable', () => {
    process.env[ENV_VAR] = '  0xdeadbeef  \n';
    expect(resolveSecret({ env: ENV_VAR }, 'label')).toBe('0xdeadbeef');
  });

  it('throws SecretResolutionError naming the env var, not any value, when unset', () => {
    expect(() => resolveSecret({ env: ENV_VAR }, 'users.funder.privateKeyRef')).toThrow(
      SecretResolutionError
    );
    try {
      resolveSecret({ env: ENV_VAR }, 'users.funder.privateKeyRef');
      throw new Error('expected resolveSecret to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretResolutionError);
      expect((error as Error).message).toContain('users.funder.privateKeyRef');
      expect((error as Error).message).toContain(ENV_VAR);
    }
  });
});

describe('resolveSecret — {file}', () => {
  it('resolves a 0600 file, trimmed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-secrets-'));
    const file = path.join(dir, 'key');
    fs.writeFileSync(file, '0xabc123\n');
    fs.chmodSync(file, 0o600);
    try {
      expect(resolveSecret({ file }, 'label')).toBe('0xabc123');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not mode 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-secrets-'));
    const file = path.join(dir, 'key');
    fs.writeFileSync(file, '0xabc123\n');
    fs.chmodSync(file, 0o644);
    try {
      expect(() => resolveSecret({ file }, 'label')).toThrow(SecretResolutionError);
      expect(() => resolveSecret({ file }, 'label')).toThrow(/0600/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('error message names the path, never the file contents', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-secrets-'));
    const file = path.join(dir, 'key');
    const secretValue = '0xSUPERSECRETVALUE';
    fs.writeFileSync(file, secretValue);
    fs.chmodSync(file, 0o644);
    try {
      expect(() => resolveSecret({ file }, 'label')).toThrow(
        new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      );
      try {
        resolveSecret({ file }, 'label');
      } catch (error) {
        expect((error as Error).message).not.toContain(secretValue);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveSecretLines', () => {
  it('splits on newlines, trims, and drops blank lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-secrets-'));
    const file = path.join(dir, 'keys');
    fs.writeFileSync(file, '0xone\n\n  0xtwo  \n0xthree\n');
    fs.chmodSync(file, 0o600);
    try {
      expect(resolveSecretLines({ file }, 'label')).toStrictEqual(['0xone', '0xtwo', '0xthree']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
