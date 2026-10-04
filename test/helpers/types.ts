import assert from 'node:assert/strict';

export function assertPresent<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

// Test doubles implement the parts of an external API exercised by the test.
// Keep the assertion at this boundary rather than weakening production types.
export function partialMock<T>(value: unknown): T {
  return value as T;
}
