import { createRequire } from 'node:module';

import { AccountStateStore } from '../../src/AccountStateStore';
import { ExchangeAccountStateStore } from '../../src/core/ExchangeAccountStateStore';
import packageJson from '../../package.json';
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

  it('keeps the existing package root export map intact', () => {
    expect(packageJson.main).toBe('dist/cjs/index.js');
    expect(packageJson.module).toBe('dist/mjs/index.js');
    expect(packageJson.types).toBe('dist/mjs/index.d.ts');
    expect(packageJson.exports['.']).toEqual({
      import: './dist/mjs/index.js',
      require: './dist/cjs/index.js',
      types: './dist/mjs/index.d.ts',
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
});
