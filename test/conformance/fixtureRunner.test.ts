import {
  defaultAccountStateFixtures,
  runAccountStateFixtures,
} from '../../src/conformance';
import type { AccountStateFixture } from '../../src/conformance';

describe('accountstate conformance fixtures', () => {
  it('passes the default generic fixture pack', () => {
    const results = runAccountStateFixtures({
      fixtures: defaultAccountStateFixtures,
    });

    expect(
      results.map((result) => ({
        name: result.fixture.name,
        passed: result.passed,
        failures: result.failures,
      })),
    ).toEqual(
      defaultAccountStateFixtures.map((fixture) => ({
        name: fixture.name,
        passed: true,
        failures: [] as [],
      })),
    );
  });

  it('returns structured failures without throwing', () => {
    const fixture: AccountStateFixture = {
      ...defaultAccountStateFixtures[0],
      expect: {
        ...defaultAccountStateFixtures[0].expect,
        positions: [{ symbol: 'ETHUSDT' }],
      },
    };

    const [result] = runAccountStateFixtures({ fixtures: [fixture] });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      expect.objectContaining({
        path: 'positions',
        message: 'Expected 1 row(s), received 0.',
      }),
    ]);
  });
});
