import { access, copyFile, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cloudFunctionsBuildRoot = path.join(repositoryRoot, '.build', 'cloudfunctions');
const functionAllowlist = ['planning-api', 'photo-cleanup'];

function sourceDirectory(functionName) {
  return functionName === 'planning-api' ? path.join('dist', 'deploy') : 'dist';
}

for (const functionName of functionAllowlist) {
  const sourceEntry = path.join(
    repositoryRoot,
    'cloudfunctions',
    functionName,
    sourceDirectory(functionName),
    'index.js'
  );
  await access(sourceEntry);
  if ((await lstat(sourceEntry)).isSymbolicLink()) {
    throw new Error(`Refusing to package a linked function entry: ${functionName}`);
  }
}

const expectedBuildRoot = path.resolve(repositoryRoot, '.build', 'cloudfunctions');
if (path.resolve(cloudFunctionsBuildRoot) !== expectedBuildRoot) {
  throw new Error(`Refusing to clean unexpected deployment root: ${cloudFunctionsBuildRoot}`);
}
await rm(cloudFunctionsBuildRoot, { recursive: true, force: true });
await mkdir(cloudFunctionsBuildRoot, { recursive: true });

for (const functionName of functionAllowlist) {
  const sourceEntry = path.join(
    repositoryRoot,
    'cloudfunctions',
    functionName,
    sourceDirectory(functionName),
    'index.js'
  );
  const destination = path.join(cloudFunctionsBuildRoot, functionName);
  if (path.dirname(path.resolve(destination)) !== expectedBuildRoot) {
    throw new Error(`Refusing to package unexpected deployment directory: ${destination}`);
  }
  await mkdir(destination, { recursive: true });
  await copyFile(sourceEntry, path.join(destination, 'index.js'));
  await writeFile(
    path.join(destination, 'package.json'),
    `${JSON.stringify({
      name: functionName,
      version: '0.1.0',
      private: true,
      main: 'index.js'
    }, null, 2)}\n`,
    'utf8'
  );
}
