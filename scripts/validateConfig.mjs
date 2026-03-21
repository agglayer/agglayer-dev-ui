import fs from 'node:fs';
import path from 'node:path';
import { parseConfigOrThrow } from '../config/configValidator.mjs';

const run = () => {
  const configPath = path.resolve(process.cwd(), 'config.json');
  const fileContent = fs.readFileSync(configPath, 'utf8');

  let configJson;
  try {
    configJson = JSON.parse(fileContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown JSON parse error';
    throw new Error(`config.json parse failed: ${message}`);
  }

  parseConfigOrThrow(configJson, { sourceName: 'config.json' });

  process.stdout.write('config.json validation passed\n');
};

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown validation error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
