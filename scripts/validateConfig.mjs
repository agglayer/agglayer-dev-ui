import { loadConfigFromDiskOrThrow } from '../config/configLoaderNode.mjs';

const run = () => {
  // Optional path argument, so the same command can vet a *candidate* config
  // before it is mounted into the container -- which is what docs/docker.md
  // and entrypoint.sh tell operators to do, and which the container's own
  // entrypoint cannot do for them (the nginx:alpine runtime has no Node, so
  // it can only run the structural `jq` check). With no argument this keeps
  // its previous behaviour: validate the repo-root config.json.
  //   pnpm run validate:config                     # repo-root config.json
  //   pnpm run validate:config -- ./my-config.json # a candidate file
  // pnpm forwards the `--` separator itself, so drop it rather than treating
  // it as a filename.
  const configPath = process.argv.slice(2).find((arg) => arg !== '--');

  // allowRelative: true -- this is a standalone shape check with no serving
  // origin available, so a relative aggkitBridgeApis value must be accepted
  // as-is rather than requiring (or attempting) resolution.
  loadConfigFromDiskOrThrow({ allowRelative: true, ...(configPath ? { configPath } : {}) });

  process.stdout.write(`${configPath ?? 'config.json'} validation passed\n`);
};

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown validation error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
