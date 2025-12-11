import type { CommandResult, PushOptions } from '../../types/index.js';

export type PushResolutionSource = 'explicit' | 'latest-stable' | 'unversioned';

export type PushMode = 'full' | 'partial';

export interface PushResolution {
  pkg: any;
  versionToPush?: string;
  source: PushResolutionSource;
}

export interface PushRequestContext {
  parsedName: string;
  parsedVersion?: string;
  requestedPaths: string[];
  mode: PushMode;
}

export interface PushPipelineOptions extends PushOptions {}

export interface PushPipelineResult {
  packageName: string;
  version: string;
  size: number;
  checksum: string;
  registry: string;
  profile: string;
  message?: string;
}

export type PushCommandResult = CommandResult<PushPipelineResult>;

