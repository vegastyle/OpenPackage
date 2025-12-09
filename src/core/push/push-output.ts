import { UNVERSIONED } from '../../constants/index.js';
import { formatVersionLabel, isUnversionedVersion } from '../../utils/package-versioning.js';
import { formatFileSize } from '../../utils/formatters.js';
import type { PushPackageResponse } from '../../types/api.js';
import type { createTarballFromPackage } from '../../utils/tarball.js';
import type { PushMode } from './push-types.js';

type TarballInfo = Awaited<ReturnType<typeof createTarballFromPackage>>;

interface PushSummaryParams {
  packageName: string;
  profile: string;
  registryUrl: string;
  pkg: any;
  mode: PushMode;
  requestedPaths: string[];
}

export function logPushSummary({
  packageName,
  profile,
  registryUrl,
  pkg,
  mode,
  requestedPaths
}: PushSummaryParams): void {
  console.log(`✓ Pushing package '${packageName}' to remote registry...`);
  const manifestVersion = pkg?.metadata?.version;
  if (!isUnversionedVersion(manifestVersion)) {
    console.log(`✓ Version: ${formatVersionLabel(manifestVersion)}`);
  }
  console.log(`✓ Profile: ${profile}`);
  console.log(`✓ Registry: ${registryUrl}`);
  if (mode === 'partial' && requestedPaths.length > 0) {
    logPartialPushRequest(requestedPaths);
  }
  console.log('');
  console.log('✓ Package validation complete');
  console.log(`  • Name: ${pkg.metadata.name}`);
  if (!isUnversionedVersion(manifestVersion)) {
    console.log(`  • Version: ${formatVersionLabel(manifestVersion)}`);
  }
  console.log(`  • Description: ${pkg.metadata.description || '(no description)'}`);
  console.log(`  • Files: ${pkg.files.length}`);
}

export function logPartialPushRequest(requestedPaths: string[]): void {
  console.log(`✓ Partial push requested for paths: ${requestedPaths.join(', ')}`);
}

export function printPushSuccess(
  response: PushPackageResponse,
  tarballInfo: TarballInfo,
  registryUrl: string
): void {
  console.log('✓ Push successful');
  console.log('');
  console.log('✓ Package Details:');
  console.log(`  • Name: ${response.package.name}`);
  if (!isUnversionedVersion(response.version.version)) {
    console.log(`  • Version: ${response.version.version ?? UNVERSIONED}`);
  }
  console.log(`  • Size: ${formatFileSize(tarballInfo.size)}`);
  const keywords = Array.isArray(response.package.keywords) ? response.package.keywords : [];
  if (keywords.length > 0) {
    console.log(`  • Keywords: ${keywords.join(', ')}`);
  }
  console.log(`  • Private: ${response.package.isPrivate ? 'Yes' : 'No'}`);
  console.log(`  • Registry: ${registryUrl}`);
  console.log(`  • Created: ${new Date(response.version.createdAt).toLocaleString()}`);
}

