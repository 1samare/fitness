import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceEntry = path.join(
  repositoryRoot,
  'cloudfunctions',
  'planning-api',
  'dist',
  'index.js'
);
const cloudFunctionsBuildRoot = path.join(repositoryRoot, '.build', 'cloudfunctions');
const destination = path.join(cloudFunctionsBuildRoot, 'planning-api');
const expectedDestination = path.resolve(
  repositoryRoot,
  '.build',
  'cloudfunctions',
  'planning-api'
);

if (
  path.resolve(destination) !== expectedDestination
  || path.dirname(expectedDestination) !== path.resolve(cloudFunctionsBuildRoot)
) {
  throw new Error(`Refusing to clean unexpected deployment directory: ${destination}`);
}

await access(sourceEntry);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await copyFile(sourceEntry, path.join(destination, 'index.js'));
await writeFile(
  path.join(destination, 'package.json'),
  `${JSON.stringify({
    name: 'planning-api',
    version: '0.1.0',
    private: true,
    main: 'index.js'
  }, null, 2)}\n`,
  'utf8'
);
