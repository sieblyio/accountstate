import { createHash } from 'node:crypto';

/**
 * Return a SHA-256 fingerprint for an exact event payload using stable object
 * key ordering. Use this for replay protection outside the reducer; it is not a
 * semantic exchange event id.
 */
export function fingerprintExactPayload(payload: unknown): string {
  return createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  return stableStringifyValue(value, new WeakSet<object>(), false);
}

function stableStringifyValue(
  value: unknown,
  seen: WeakSet<object>,
  inArray: boolean,
): string {
  if (value === undefined || typeof value === 'function') {
    return inArray ? 'null' : undefinedMarker();
  }
  if (typeof value === 'symbol') {
    return inArray ? 'null' : undefinedMarker();
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (seen.has(value)) {
    throw new Error('Cannot fingerprint circular payload');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const serialized = value.map((item) =>
      stableStringifyValue(item, seen, true),
    );
    seen.delete(value);
    return `[${serialized.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .flatMap((key) => {
      const serialized = stableStringifyValue(record[key], seen, false);
      return serialized === undefinedMarker()
        ? []
        : [`${JSON.stringify(key)}:${serialized}`];
    });

  seen.delete(value);
  return `{${entries.join(',')}}`;
}

function undefinedMarker(): string {
  return '__accountstate_undefined__';
}
