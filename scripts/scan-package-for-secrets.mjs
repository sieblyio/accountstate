import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(fileURLToPath(new URL('..', import.meta.url)));
const packageJsonPath = join(packageRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

const disallowedPackageEntries = new Set([
  '.npmrc',
  '.npmrc.template',
  'llms.txt',
]);
const disallowedFileNames = new Set(['.npmrc', '.npmrc.template']);
const contentPatterns = [
  { name: 'npm auth token marker', regex: /_authToken\s*=/i },
  { name: 'npm token environment marker', regex: /\bNPM_TOKEN\b/i },
  {
    name: 'npm registry auth marker',
    regex: /\/\/registry\.npmjs\.org\/:/i,
  },
  { name: 'secret npmrc instruction', regex: /Keep this secret/i },
];

const failures = [];

for (const entry of packageJson.files ?? []) {
  const normalized = String(entry).replace(/^!/, '');
  if (disallowedPackageEntries.has(normalized)) {
    failures.push(`package.json files includes ${normalized}`);
  }
}

for (const file of listPackageSurfaceFiles()) {
  if (disallowedFileNames.has(basename(file))) {
    failures.push(`publishable package surface includes ${relative(file)}`);
    continue;
  }

  const content = readFileSync(file, 'utf8');
  for (const pattern of contentPatterns) {
    if (pattern.regex.test(content)) {
      failures.push(`${relative(file)} contains ${pattern.name}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Package secret scan failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function listPackageSurfaceFiles() {
  const files = [
    packageJsonPath,
    join(packageRoot, 'README.md'),
  ];

  for (const dir of ['docs', 'dist']) {
    const fullPath = join(packageRoot, dir);
    if (existsSync(fullPath)) {
      files.push(...walk(fullPath));
    }
  }

  return files;
}

function walk(path) {
  const stat = statSync(path);
  if (stat.isFile()) {
    return [path];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

function relative(path) {
  return path.replace(`${packageRoot}/`, '');
}
