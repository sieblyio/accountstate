import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AccountStateStore } from '../../src/AccountStateStore';
import { ExchangeAccountStateStore } from '../../src/core/ExchangeAccountStateStore';
import packageJson from '../../package.json';
import * as sourceBinance from '../../src/adapters/binance';
import * as sourceConformance from '../../src/conformance';
import * as sourceCore from '../../src/core';
import * as sourceRoot from '../../src/index';

const requireFromTest = createRequire(__filename);

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
  });

  it('emits no runtime Binance SDK import in package root or adapter JS', () => {
    const files = [
      join(__dirname, '../../dist/cjs/index.js'),
      join(__dirname, '../../dist/cjs/adapters/binance/index.js'),
      join(__dirname, '../../dist/cjs/adapters/binance/types.js'),
      join(__dirname, '../../dist/cjs/adapters/binance/normalize.js'),
      join(__dirname, '../../dist/mjs/index.js'),
      join(__dirname, '../../dist/mjs/adapters/binance/index.js'),
      join(__dirname, '../../dist/mjs/adapters/binance/types.js'),
      join(__dirname, '../../dist/mjs/adapters/binance/normalize.js'),
    ];

    for (const file of files) {
      expect(existsSync(file)).toBe(true);
      const js = readFileSync(file, 'utf8');
      expect(js).not.toContain("from 'binance'");
      expect(js).not.toContain('from "binance"');
      expect(js).not.toContain("require('binance')");
      expect(js).not.toContain('require("binance")');
    }
  });
});
