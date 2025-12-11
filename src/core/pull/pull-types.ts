import type { PackageVersionState } from '../package.js';

export interface PullPipelineResult {
  packageName: string;
  version: string;
  files: number;
  size: number;
  checksum: string;
  registry: string;
  profile: string;
  isPrivate: boolean;
  downloadUrl: string;
  message: string;
}

export interface PartialPullConfig {
  requestPaths: string[];
  localState?: PackageVersionState;
}


