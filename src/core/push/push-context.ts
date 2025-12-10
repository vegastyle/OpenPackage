import * as semver from 'semver';

import { UNVERSIONED } from '../../constants/index.js';
import { getCurrentUsername } from '../api-keys.js';
import { listPackageVersions } from '../directory.js';
import { packageManager } from '../package.js';
import { resolveScopedNameForPushWithUserScope, isScopedName } from '../scoping/package-scoping.js';
import { parsePackagePushSpec } from '../../utils/package-name.js';
import { getLatestStableVersion } from '../../utils/package-versioning.js';
import { promptConfirmation } from '../../utils/prompts.js';
import { logger } from '../../utils/logger.js';
import { PushError } from './push-errors.js';
import { buildRequestedPaths } from '../../utils/registry-paths.js';
import { UserCancellationError } from '../../utils/errors.js';
import type { PushRequestContext, PushResolution } from './push-types.js';
import type { PushOptions } from '../../types/index.js';

export function resolvePushRequestContext(
  packageInput: string,
  optionPaths: string[] | undefined
): PushRequestContext {
  const parsedSpec = parsePackagePushSpec(packageInput);
  const requestedPaths = buildRequestedPaths(optionPaths, parsedSpec.registryPath);

  const mode = requestedPaths.length > 0 ? 'partial' : 'full';

  return {
    parsedName: parsedSpec.name,
    parsedVersion: parsedSpec.version,
    requestedPaths,
    mode
  };
}

export async function resolveUploadNameForPush(
  packageName: string,
  authOptions: PushOptions
): Promise<string> {
  if (isScopedName(packageName)) {
    return packageName;
  }

  const username = await getCurrentUsername(authOptions);
  return await resolveScopedNameForPushWithUserScope(packageName, username, authOptions.profile);
}

export async function resolvePushResolution(
  packageName: string,
  parsedVersion?: string
): Promise<PushResolution> {
  if (parsedVersion) {
    return resolveExplicitPush(packageName, parsedVersion);
  }

  return resolveImplicitPush(packageName, async (latest) => {
    const proceed = await promptConfirmation(`Push latest stable version '${latest}'?`, true);
    if (!proceed) {
      throw new UserCancellationError('User declined pushing the stable version');
    }
  });
}

export function validateUploadVersion(uploadVersion?: string): void {
  if (!uploadVersion) {
    return;
  }

  assertStableSemver(uploadVersion);
}

function assertStableSemver(version: string): void {
  if (!semver.valid(version)) {
    throw new PushError(`Invalid version: ${version}. Provide a valid semver version.`, 'INVALID_VERSION');
  }
  if (semver.prerelease(version)) {
    throw new PushError(`Prerelease versions cannot be pushed: ${version}`, 'PRERELEASE_DISALLOWED');
  }
}

async function resolveExplicitPush(packageName: string, parsedVersion: string): Promise<PushResolution> {
  assertStableSemver(parsedVersion);
  const pkg = await packageManager.loadPackage(packageName, parsedVersion);
  logVersionMismatch(packageName, parsedVersion, pkg.metadata.version);
  const effectiveVersion = pkg.metadata.version ?? parsedVersion;
  return { pkg, versionToPush: effectiveVersion, source: 'explicit' };
}

async function resolveImplicitPush(
	packageName: string,
	onConfirmLatest: (latest: string) => Promise<void>
): Promise<PushResolution> {
	const allVersions = await listPackageVersions(packageName);
	const stableVersions = allVersions.filter((version) => version !== UNVERSIONED);
	const latestStable = getLatestStableVersion(stableVersions);

	if (latestStable) {
		await onConfirmLatest(latestStable);
		const pkg = await packageManager.loadPackage(packageName, latestStable);
		const effectiveVersion = pkg.metadata.version ?? latestStable;
		return { pkg, versionToPush: effectiveVersion, source: 'latest-stable' };
	}

	if (allVersions.includes(UNVERSIONED)) {
		const pkg = await packageManager.loadPackage(packageName, UNVERSIONED);
		const manifestVersion = pkg.metadata.version;

		if (manifestVersion === undefined || manifestVersion === null) {
			return { pkg, versionToPush: undefined, source: 'unversioned' };
		}

		assertStableSemver(manifestVersion);
		await onConfirmLatest(manifestVersion);
		return { pkg, versionToPush: manifestVersion, source: 'latest-stable' };
	}

	throw new PushError(
		`No versions found for package '${packageName}'. Create a package with "opkg pack <package>" or ensure package.yml exists.`,
		'NO_VERSIONS'
	);
}

function logVersionMismatch(packageName: string, requested: string, manifestVersion?: string): void {
  if (manifestVersion && manifestVersion !== requested) {
    logger.warn('Version mismatch between manifest and requested push', {
      packageName,
      manifestVersion,
      requested
    });
  }
}

