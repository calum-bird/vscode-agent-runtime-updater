import type { CodexHost } from './types';
import { isRecord } from './json';

function usesMusl(platform: string): boolean {
  if (platform !== 'linux') return false;
  const report = process.report?.getReport();
  return !(isRecord(report) && isRecord(report.header) && report.header.glibcVersionRuntime);
}

function target(platform: string = process.platform, arch: string = process.arch): CodexHost {
  const id = `${platform}-${arch}`;
  const triples: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'linux-x64': 'x86_64-unknown-linux-musl',
  };
  const triple = triples[id];
  if (!triple)
    throw new Error(`Unsupported host ${id}. This extension supports macOS and Linux x64/arm64.`);
  return { id, triple };
}

export { target, usesMusl };
