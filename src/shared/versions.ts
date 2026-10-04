function stableVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Expected a stable runtime version, received ${String(value)}.`);
  }
  return value;
}

function compareVersions(a: string, b: string): number {
  const left = stableVersion(a).split('.').map(Number);
  const right = stableVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

export { stableVersion, compareVersions };
