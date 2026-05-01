import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountStateStore } from '../../src/AccountStateStore';
import { ExchangeAccountStateStore } from '../../src/core/ExchangeAccountStateStore';
import packageJson from '../../package.json';
import * as sourceBinance from '../../src/adapters/binance';
import * as sourceBybit from '../../src/adapters/bybit';
import * as sourceConformance from '../../src/conformance';
import * as sourceCore from '../../src/core';
import * as sourceRoot from '../../src/index';

const requireFromTest = createRequire(__filename);
const packageRoot = join(__dirname, '../..');
const tscBin = join(packageRoot, 'node_modules/.bin/tsc');

interface FixtureProjectOptions {
  includeBinance?: boolean;
  includeBybit?: boolean;
}

describe('root package exports', () => {
  it('keeps the current root source exports available', () => {
    expect(sourceRoot.AccountStateStore).toBe(AccountStateStore);
    expect(sourceRoot.ExchangeAccountStateStore).toBe(
      ExchangeAccountStateStore,
    );
    expect(sourceRoot.ENGINE_POSITION_SIDE).toEqual({
      LONG: 'LONG',
      SHORT: 'SHORT',
      NONE: 'NONE',
    });
    expect(sourceRoot.ENGINE_ORDER_POSITION_SIDE).toEqual({
      LONG: 'LONG',
      SHORT: 'SHORT',
      BOTH: 'BOTH',
    });
    expect(typeof sourceRoot.getUnrealisedPnl).toBe('function');
    expect(typeof sourceRoot.calculateDepthForPositions).toBe('function');
    expect(typeof sourceRoot.reportBalanceToApi).toBe('function');
  });

  it('keeps reducer/fact types off the root autocomplete surface', () => {
    expect('AccountFact' in sourceRoot).toBe(false);
    expect('RestSnapshotFact' in sourceRoot).toBe(false);
    expect('StreamHealthFact' in sourceRoot).toBe(false);
    expect('SnapshotInput' in sourceRoot).toBe(false);
    expect(sourceCore.ExchangeAccountStateStore).toBe(
      ExchangeAccountStateStore,
    );
  });

  it('keeps the package export map explicit', () => {
    expect(packageJson.main).toBe('dist/cjs/index.js');
    expect(packageJson.module).toBe('dist/mjs/index.js');
    expect(packageJson.types).toBe('dist/mjs/index.d.ts');
    expect(packageJson.exports['.']).toEqual({
      import: './dist/mjs/index.js',
      require: './dist/cjs/index.js',
      types: './dist/mjs/index.d.ts',
    });
    expect(packageJson.exports['./core']).toEqual({
      import: './dist/mjs/core/index.js',
      require: './dist/cjs/core/index.js',
      types: './dist/mjs/core/index.d.ts',
    });
    expect(packageJson.exports['./conformance']).toEqual({
      import: './dist/mjs/conformance.js',
      require: './dist/cjs/conformance.js',
      types: './dist/mjs/conformance.d.ts',
    });
    expect(packageJson.exports['./binance']).toEqual({
      import: './dist/mjs/adapters/binance/index.js',
      require: './dist/cjs/adapters/binance/index.js',
      types: './dist/mjs/adapters/binance/index.d.ts',
    });
    expect(packageJson.exports['./bybit']).toEqual({
      import: './dist/mjs/adapters/bybit/index.js',
      require: './dist/cjs/adapters/bybit/index.js',
      types: './dist/mjs/adapters/bybit/index.d.ts',
    });
    expect(packageJson.files).toContain('docs/**/*.md');
    expect(packageJson.files).not.toContain('llms.txt');
    expect(packageJson.files).not.toContain('.npmrc');
    expect(packageJson.files).not.toContain('.npmrc.template');
  });

  it('loads the built CommonJS package root after build', () => {
    const builtRoot = requireFromTest('../..') as typeof sourceRoot;

    expect(builtRoot.AccountStateStore).toBeDefined();
    expect(typeof builtRoot.AccountStateStore).toBe('function');
    expect(builtRoot.ExchangeAccountStateStore).toBeDefined();
    expect(typeof builtRoot.ExchangeAccountStateStore).toBe('function');
    expect(builtRoot.ENGINE_POSITION_SIDE).toEqual(
      sourceRoot.ENGINE_POSITION_SIDE,
    );
    expect(typeof builtRoot.getUnrealisedPnl).toBe('function');
  });

  it('loads the package root in a fixture project without Binance installed', () => {
    const projectDir = createPackageFixtureProject();
    try {
      const fixtureRequire = createRequire(join(projectDir, 'index.cjs'));

      expect(() => fixtureRequire.resolve('binance')).toThrow();

      const builtRoot = fixtureRequire('accountstate') as typeof sourceRoot;
      const state = new builtRoot.ExchangeAccountStateStore();

      expect(typeof builtRoot.AccountStateStore).toBe('function');
      expect(typeof builtRoot.ExchangeAccountStateStore).toBe('function');
      expect(state.getOpenOrders(fixtureScope)).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('loads the package root through ESM import without Binance installed', () => {
    const projectDir = createPackageFixtureProject();
    try {
      writeFileSync(
        join(projectDir, 'index.mjs'),
        `
          import { ExchangeAccountStateStore } from 'accountstate';

          const state = new ExchangeAccountStateStore();
          const orders = state.getOpenOrders({
            exchange: 'fixture',
            accountId: 'primary',
            product: 'test'
          });

          if (!Array.isArray(orders)) {
            throw new Error('Expected open orders array');
          }
        `,
      );

      expect(runFixtureNode(projectDir, 'index.mjs').ok).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('type-checks the package root in a fixture project without Binance installed', () => {
    const projectDir = createPackageFixtureProject();
    try {
      writeFixtureTypeProject(
        projectDir,
        `
          import { ExchangeAccountStateStore, type AccountScope } from 'accountstate';

          const scope: AccountScope = {
            exchange: 'test',
            accountId: 'primary',
            product: 'linear'
          };

          const state = new ExchangeAccountStateStore();
          state.setOpenOrders(scope, []);
        `,
      );

      expect(runFixtureTsc(projectDir).ok).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('reports the missing Binance peer for Binance subpath type imports', () => {
    const projectDir = createPackageFixtureProject();
    try {
      writeFixtureTypeProject(
        projectDir,
        `
          import type { BinanceUsdmPositionRow } from 'accountstate/binance';

          const row: BinanceUsdmPositionRow | undefined = undefined;
          void row;
        `,
      );

      const result = runFixtureTsc(projectDir);

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Cannot find module 'binance'");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('type-checks the Binance subpath when the Binance peer is installed', () => {
    const projectDir = createPackageFixtureProject({ includeBinance: true });
    try {
      writeFixtureTypeProject(
        projectDir,
        `
          import { binance, type BinanceUsdmPositionRow } from 'accountstate/binance';
          import type { AccountScope } from 'accountstate';

          const scope: AccountScope = {
            exchange: 'binance',
            accountId: 'primary',
            product: 'usdm'
          };

          declare const rows: BinanceUsdmPositionRow[];
          const fact = binance.rest.positions(scope, rows);
          void fact;
        `,
      );

      const result = runFixtureTsc(projectDir);

      expect(result.ok).toBe(true);
      expect(result.output).toBe('');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('reports the missing Bybit peer for Bybit subpath type imports', () => {
    const projectDir = createPackageFixtureProject();
    try {
      writeFixtureTypeProject(
        projectDir,
        `
          import type { BybitV5LinearPositionRow } from 'accountstate/bybit';

          const row: BybitV5LinearPositionRow | undefined = undefined;
          void row;
        `,
      );

      const result = runFixtureTsc(projectDir);

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Cannot find module 'bybit-api'");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('type-checks the Bybit subpath when the Bybit peer is installed', () => {
    const projectDir = createPackageFixtureProject({ includeBybit: true });
    try {
      writeFixtureTypeProject(
        projectDir,
        `
          import { bybit, type BybitV5LinearPositionRow } from 'accountstate/bybit';
          import type { AccountScope } from 'accountstate';

          const scope: AccountScope = {
            exchange: 'bybit',
            accountId: 'primary',
            product: 'linear'
          };

          declare const rows: BybitV5LinearPositionRow[];
          const fact = bybit.rest.positions(scope, rows);
          void fact;
        `,
      );

      const result = runFixtureTsc(projectDir);

      expect(result.ok).toBe(true);
      expect(result.output).toBe('');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('loads the built CommonJS core subpath after build', () => {
    const builtCore = requireFromTest('accountstate/core') as typeof sourceCore;

    expect(builtCore.ExchangeAccountStateStore).toBeDefined();
    expect(typeof builtCore.ExchangeAccountStateStore).toBe('function');
  });

  it('loads the built CommonJS conformance subpath after build', () => {
    const builtConformance = requireFromTest(
      'accountstate/conformance',
    ) as typeof sourceConformance;

    expect(typeof builtConformance.runAccountStateFixtures).toBe('function');
    expect(builtConformance.defaultAccountStateFixtures.length).toBeGreaterThan(
      0,
    );
  });

  it('loads the built CommonJS Binance subpath after build', () => {
    const builtBinance = requireFromTest(
      'accountstate/binance',
    ) as typeof sourceBinance;

    expect(typeof builtBinance.normalizeBinanceUsdmPosition).toBe('function');
    expect(typeof builtBinance.binance.rest.positions).toBe('function');
    expect(typeof builtBinance.binance.submission.cancelRejected).toBe(
      'function',
    );
  });

  it('loads the built CommonJS Bybit subpath after build', () => {
    const builtBybit = requireFromTest(
      'accountstate/bybit',
    ) as typeof sourceBybit;

    expect(typeof builtBybit.normalizeBybitV5LinearPosition).toBe('function');
    expect(typeof builtBybit.bybit.rest.positions).toBe('function');
    expect(typeof builtBybit.bybit.submission.cancelRejected).toBe('function');
  });

  it('emits no runtime exchange SDK import in package root or adapter JS', () => {
    const files = [
      join(__dirname, '../../dist/cjs/index.js'),
      join(__dirname, '../../dist/cjs/adapters/binance/index.js'),
      join(__dirname, '../../dist/cjs/adapters/binance/submission.js'),
      join(__dirname, '../../dist/cjs/adapters/binance/types.js'),
      join(__dirname, '../../dist/cjs/adapters/binance/normalize.js'),
      join(__dirname, '../../dist/cjs/adapters/bybit/index.js'),
      join(__dirname, '../../dist/cjs/adapters/bybit/submission.js'),
      join(__dirname, '../../dist/cjs/adapters/bybit/types.js'),
      join(__dirname, '../../dist/cjs/adapters/bybit/normalize.js'),
      join(__dirname, '../../dist/mjs/index.js'),
      join(__dirname, '../../dist/mjs/adapters/binance/index.js'),
      join(__dirname, '../../dist/mjs/adapters/binance/submission.js'),
      join(__dirname, '../../dist/mjs/adapters/binance/types.js'),
      join(__dirname, '../../dist/mjs/adapters/binance/normalize.js'),
      join(__dirname, '../../dist/mjs/adapters/bybit/index.js'),
      join(__dirname, '../../dist/mjs/adapters/bybit/submission.js'),
      join(__dirname, '../../dist/mjs/adapters/bybit/types.js'),
      join(__dirname, '../../dist/mjs/adapters/bybit/normalize.js'),
    ];

    for (const file of files) {
      expect(existsSync(file)).toBe(true);
      const js = readFileSync(file, 'utf8');
      expect(js).not.toContain("from 'binance'");
      expect(js).not.toContain('from "binance"');
      expect(js).not.toContain("require('binance')");
      expect(js).not.toContain('require("binance")');
      expect(js).not.toContain("from 'bybit-api'");
      expect(js).not.toContain('from "bybit-api"');
      expect(js).not.toContain("require('bybit-api')");
      expect(js).not.toContain('require("bybit-api")');
    }
  });

  it('keeps reducer and fact types out of the root declaration surface', () => {
    const rootDts = readFileSync(
      join(__dirname, '../../dist/mjs/index.d.ts'),
      'utf8',
    );
    const coreDts = readFileSync(
      join(__dirname, '../../dist/mjs/core/index.d.ts'),
      'utf8',
    );

    for (const internalType of [
      'AccountFact',
      'RestSnapshotFact',
      'StreamHealthFact',
      'TerminalEvidenceFact',
      'SnapshotInput',
      'Provenance',
      'AccountViewConfidence',
    ]) {
      expect(rootDts).not.toContain(internalType);
    }

    expect(coreDts).toContain('AccountFact');
    expect(coreDts).toContain('SnapshotInput');
  });

  it('keeps root output exchange-agnostic and adapters free of SDK side effects', () => {
    for (const file of [
      join(__dirname, '../../dist/cjs/index.js'),
      join(__dirname, '../../dist/mjs/index.js'),
      join(__dirname, '../../dist/cjs/index.d.ts'),
      join(__dirname, '../../dist/mjs/index.d.ts'),
    ]) {
      expect(existsSync(file)).toBe(true);
      const content = readFileSync(file, 'utf8');
      expect(content).not.toContain('adapters/binance');
      expect(content).not.toContain('adapters/bybit');
      expect(content).not.toContain('accountstate/binance');
      expect(content).not.toContain('accountstate/bybit');
      expect(content).not.toContain('binance');
      expect(content).not.toContain('bybit');
    }

    const adapterFiles = [
      ...findFiles(join(packageRoot, 'src/adapters/binance'), '.ts'),
      ...findFiles(join(packageRoot, 'src/adapters/bybit'), '.ts'),
      ...findFiles(join(packageRoot, 'dist/cjs/adapters/binance'), '.js'),
      ...findFiles(join(packageRoot, 'dist/cjs/adapters/bybit'), '.js'),
      ...findFiles(join(packageRoot, 'dist/mjs/adapters/binance'), '.js'),
      ...findFiles(join(packageRoot, 'dist/mjs/adapters/bybit'), '.js'),
    ];

    for (const file of adapterFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toContain('process.env');
      expect(content).not.toContain('setTimeout');
      expect(content).not.toContain('setInterval');
      expect(content).not.toMatch(
        /\bnew\s+(?:MainClient|USDMClient|WebsocketClient|WebsocketAPIClient|CoinMClient|PortfolioClient)\b/,
      );
      expect(content).not.toMatch(/\bnew\s+RestClientV5\b/);
    }
  });
});

const fixtureScope = {
  exchange: 'fixture',
  accountId: 'primary',
  product: 'test',
};

function createPackageFixtureProject(
  options: FixtureProjectOptions = {},
): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'accountstate-package-'));
  const nodeModulesDir = join(projectDir, 'node_modules');
  const packageDir = join(nodeModulesDir, 'accountstate');

  mkdirSync(nodeModulesDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  cpSync(join(packageRoot, 'dist'), join(packageDir, 'dist'), {
    recursive: true,
  });
  cpSync(join(packageRoot, 'package.json'), join(packageDir, 'package.json'));
  cpSync(join(packageRoot, 'README.md'), join(packageDir, 'README.md'));
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2),
  );

  if (options.includeBinance) {
    symlinkSync(
      join(packageRoot, 'node_modules/binance'),
      join(nodeModulesDir, 'binance'),
      'dir',
    );
  }

  if (options.includeBybit) {
    symlinkSync(
      join(packageRoot, 'node_modules/bybit-api'),
      join(nodeModulesDir, 'bybit-api'),
      'dir',
    );
  }

  return projectDir;
}

function writeFixtureTypeProject(projectDir: string, source: string): void {
  writeFileSync(join(projectDir, 'index.ts'), source);
  writeFileSync(
    join(projectDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: [],
        },
        include: ['index.ts'],
      },
      null,
      2,
    ),
  );
}

function runFixtureTsc(projectDir: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(tscBin, ['-p', 'tsconfig.json'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, output };
  } catch (error) {
    const execError = error as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return {
      ok: false,
      output: `${execError.stdout?.toString() ?? ''}${
        execError.stderr?.toString() ?? ''
      }`,
    };
  }
}

function runFixtureNode(
  projectDir: string,
  file: string,
): { ok: boolean; output: string } {
  try {
    const output = execFileSync(process.execPath, [file], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, output };
  } catch (error) {
    const execError = error as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return {
      ok: false,
      output: `${execError.stdout?.toString() ?? ''}${
        execError.stderr?.toString() ?? ''
      }`,
    };
  }
}

function findFiles(root: string, extension: string): string[] {
  const entries = readdirSync(root, {
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findFiles(fullPath, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(fullPath);
    }
  }

  return files;
}
