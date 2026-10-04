export interface Host {
  id: string;
}

export interface CodexHost extends Host {
  triple: string;
}

export interface Distribution {
  tarball: string;
  integrity: string;
}

export interface PackageMetadata {
  name: string;
  version: string;
  dist: Distribution;
  optionalDependencies?: Record<string, string>;
  claudeCodeVersion?: string;
}

export type Logger = (message: string) => void;

export interface SelectionState<Snapshot> {
  original: Snapshot;
  history: Snapshot[];
  pending?: Snapshot;
}
