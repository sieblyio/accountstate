import { isObject } from './type-guards.js';

export async function postDataToUrl(
  url: string,
  data: object,
  headers: Record<string, string> = {},
): Promise<unknown> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-type': 'application/json',
        ...headers,
      },
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(data),
    });
    return response.text();
  } catch (e) {
    console.warn(
      'Failed to parse postDataToUrl response...' + JSON.stringify(e),
    );
  }
}

export function hasStatusCode(res: unknown): res is {
  statusCode: number;
} {
  if (!isObject(res)) {
    return false;
  }
  return typeof res['statusCode'] === 'number';
}
