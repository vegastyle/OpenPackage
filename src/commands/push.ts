import { Command } from 'commander';
import { join } from 'path';
import { PushOptions, CommandResult } from '../types/index.js';
import { PushPackageResponse } from '../types/api.js';
import { packageManager } from '../core/package.js';
import { ensureRegistryDirectories, listPackageVersions } from '../core/directory.js';
import { authManager } from '../core/auth.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, PackageNotFoundError } from '../utils/errors.js';
import { createHttpClient, type HttpClient } from '../utils/http-client.js';
import { createTarballFromPackage, createFormDataForUpload } from '../utils/tarball.js';
import * as semver from 'semver';
import { parsePackageInput } from '../utils/package-name.js';
import { promptConfirmation } from '../utils/prompts.js';
import { formatFileSize } from '../utils/formatters.js';
import { Spinner } from '../utils/spinner.js';
import { showApiKeySignupMessage } from '../utils/messages.js';
import { formatVersionLabel, getLatestStableVersion, isUnversionedVersion } from '../utils/package-versioning.js';
import { resolveScopedNameForPushWithUserScope, isScopedName } from '../core/scoping/package-scoping.js';
import { renameRegistryPackage } from '../core/registry/registry-rename.js';
import { getLocalPackageDir } from '../utils/paths.js';
import { FILE_PATTERNS, DIR_PATTERNS } from '../constants/index.js';
import { exists } from '../utils/fs.js';
import { parsePackageYml } from '../utils/package-yml.js';
import { applyWorkspacePackageRename } from '../core/save/workspace-rename.js';
import { type PackageContext } from '../core/package-context.js';
import { getCurrentUsername } from '../core/api-keys.js';
import { UNVERSIONED } from '../constants/index.js';

type PushResolutionSource = 'explicit' | 'latest-stable' | 'unversioned';

interface PushResolution {
  pkg: any;
  versionToPush?: string;
  source: PushResolutionSource;
}

class PushError extends Error {
  constructor(
    message: string,
    public readonly code?:
      | 'INVALID_VERSION'
      | 'PRERELEASE_DISALLOWED'
      | 'NO_VERSIONS'
      | 'UNVERSIONED_BLOCKED'
  ) {
    super(message);
    this.name = 'PushError';
  }
}

function assertStableSemver(version: string): void {
  if (!semver.valid(version)) {
    throw new PushError(`Invalid version: ${version}. Provide a valid semver version.`, 'INVALID_VERSION');
  }
  if (semver.prerelease(version)) {
    throw new PushError(`Prerelease versions cannot be pushed: ${version}`, 'PRERELEASE_DISALLOWED');
  }
}

function logVersionMismatch(packageName: string, requested: string, manifestVersion?: string): void {
  if (manifestVersion && manifestVersion !== requested) {
    logger.warn('Version mismatch between manifest and requested push', {
      packageName,
      manifestVersion,
      requested,
    });
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
  const latestStable = getLatestStableVersion(allVersions);

  if (latestStable) {
    await onConfirmLatest(latestStable);
    const pkg = await packageManager.loadPackage(packageName, latestStable);
    const effectiveVersion = pkg.metadata.version ?? latestStable;
    return { pkg, versionToPush: effectiveVersion, source: 'latest-stable' };
  }

  if (allVersions.includes(UNVERSIONED)) {
    const pkg = await packageManager.loadPackage(packageName, UNVERSIONED);
    return { pkg, versionToPush: undefined, source: 'unversioned' };
  }

  throw new PushError(
    `No versions found for package '${packageName}'. Create a package with "opkg pack <package>" or ensure package.yml exists.`,
    'NO_VERSIONS'
  );
}

async function ensureUnversionedAllowed(
  httpClient: HttpClient,
  packageName: string
): Promise<void> {
  try {
    const remotePackage: any = await httpClient.get(`/packages/by-name/${encodeURIComponent(packageName)}`);
    const remoteVersions: string[] = Array.isArray(remotePackage?.versions)
      ? remotePackage.versions
      : [];
    const hasVersionedRemote =
      remoteVersions.some((entry: any) => {
        if (typeof entry === 'string') return semver.valid(entry);
        return entry && typeof entry.version === 'string' && semver.valid(entry.version);
      }) ||
      (remotePackage?.latestPackageVersion &&
        remotePackage.latestPackageVersion.version &&
        semver.valid(remotePackage.latestPackageVersion.version));

    if (hasVersionedRemote) {
      throw new PushError(
        'Unversioned pushes are disabled because the package already has versioned releases.',
        'UNVERSIONED_BLOCKED'
      );
    }
  } catch (error: any) {
    const apiError = error?.apiError;
    if (apiError?.statusCode === 404) {
      return; // ok: package absent remotely
    }
    if (error instanceof PushError) {
      throw error;
    }
    throw error;
  }
}

function logPushSummary(packageName: string, versionLabel: string, profile: string, pkg: any): void {
  console.log(`✓ Pushing package '${packageName}' to remote registry...`);
  console.log(`✓ Version: ${versionLabel}`);
  console.log(`✓ Profile: ${profile}`);
  console.log('');
  console.log('✓ Package validation complete');
  console.log(`  • Name: ${pkg.metadata.name}`);
  console.log(`  • Version: ${versionLabel}`);
  console.log(`  • Description: ${pkg.metadata.description || '(no description)'}`);
  console.log(`  • Files: ${pkg.files.length}`);
}

async function tryRenameWorkspacePackage(
  cwd: string,
  oldName: string,
  newName: string
): Promise<void> {
  try {
    const packageRootDir = getLocalPackageDir(cwd, oldName);
    const packageYmlPath = join(packageRootDir, DIR_PATTERNS.OPENPACKAGE, FILE_PATTERNS.PACKAGE_YML);

    if (!(await exists(packageYmlPath))) {
      return;
    }

    const config = await parsePackageYml(packageYmlPath);
    
    // Construct full PackageContext for nested package
    const packageContext: PackageContext = {
      name: config.name,
      version: config.version,
      config,
      packageYmlPath,
      packageRootDir,
      packageFilesDir: join(packageRootDir, DIR_PATTERNS.OPENPACKAGE),
      location: 'nested',
      isCwdPackage: false,
      isNew: false
    };

    await applyWorkspacePackageRename(cwd, packageContext, newName);
    console.log(`✓ Updated workspace package name: ${oldName} → ${newName}`);
  } catch (error) {
    logger.debug('Workspace package rename skipped', {
      oldName,
      newName,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function pushPackageCommand(
  packageInput: string,
  options: PushOptions
): Promise<CommandResult> {
  logger.info(`Pushing package '${packageInput}' to remote registry`, { options });
  const cwd = process.cwd();
  const { name: parsedName, version: parsedVersion } = parsePackageInput(packageInput);
  let packageNameToPush = parsedName;
  let attemptedVersion: string | undefined;

  try {
    // Ensure registry directories exist
    await ensureRegistryDirectories();

    // Verify package exists locally
    const packageExists = await packageManager.packageExists(packageNameToPush);
    if (!packageExists) {
      console.error(`❌ Package '${packageNameToPush}' not found in local registry`);
      return { success: false, error: 'Package not found' };
    }

    const authOptions = {
      profile: options.profile,
      apiKey: options.apiKey
    };

    // Authentication required for push operation (also needed for scope resolution)
    await authManager.validateAuth(authOptions);

    if (!isScopedName(packageNameToPush)) {
      const username = await getCurrentUsername(authOptions);
      const scopedName = await resolveScopedNameForPushWithUserScope(
        packageNameToPush,
        username,
        options.profile
      );
      await renameRegistryPackage(packageNameToPush, scopedName);
      await tryRenameWorkspacePackage(cwd, packageNameToPush, scopedName);
      packageNameToPush = scopedName;
    }

  // Determine which version to push
  let resolution: PushResolution;

  if (parsedVersion) {
    try {
      resolution = await resolveExplicitPush(packageNameToPush, parsedVersion);
    } catch (error) {
      if (error instanceof PushError && error.code === 'INVALID_VERSION') {
        console.error(`❌ ${error.message}`);
        return { success: false, error: 'Invalid version' };
      }
      if (error instanceof PushError && error.code === 'PRERELEASE_DISALLOWED') {
        console.error(`❌ ${error.message}`);
        console.log('Only stable versions (x.y.z) can be pushed to the remote registry.');
        console.log('💡 Create a stable version using "opkg pack <package>".');
        return { success: false, error: 'Only stable versions can be pushed' };
      }
      if (error instanceof PackageNotFoundError) {
        console.error(`❌ Version ${parsedVersion} not found for package '${packageNameToPush}'`);
        console.log('💡 Create this stable version using "opkg pack <package>" and push again.');
        return { success: false, error: 'Version not found' };
      }
      throw error;
    }
  } else {
    try {
      resolution = await resolveImplicitPush(packageNameToPush, async (latest) => {
        const proceed = await promptConfirmation(
          `Push latest stable version '${latest}'?`,
          true
        );
        if (!proceed) {
          throw new UserCancellationError('User declined pushing the stable version');
        }
      });
    } catch (error) {
      if (error instanceof PushError && error.code === 'NO_VERSIONS') {
        console.error(`❌ ${error.message}`);
        return { success: false, error: 'Version not found' };
      }
      if (error instanceof UserCancellationError) {
        throw error;
      }
      throw error;
    }
  }

  const { pkg, versionToPush } = resolution;
  const uploadVersion = isUnversionedVersion(versionToPush) ? undefined : versionToPush;
  attemptedVersion = uploadVersion;

  if (uploadVersion) {
    try {
      assertStableSemver(uploadVersion);
    } catch (error) {
      if (error instanceof PushError) {
        console.error(`❌ ${error.message}`);
        console.log('Only stable versions (x.y.z) can be pushed to the remote registry.');
        console.log('💡 Create a stable version using "opkg pack <package>".');
        return { success: false, error: 'Only stable versions can be pushed' };
      }
      throw error;
    }
  }
    
  // Authenticate and create HTTP client
  const httpClient = await createHttpClient(authOptions);

  // If pushing unversioned, ensure remote does not have versioned releases
  if (isUnversionedVersion(versionToPush)) {
    try {
      await ensureUnversionedAllowed(httpClient, packageNameToPush);
    } catch (error) {
      if (error instanceof PushError && error.code === 'UNVERSIONED_BLOCKED') {
        console.error('❌ Unversioned pushes are disabled because the package already has versioned releases.');
        console.log('💡 Add a semver version to package.yml (e.g., version: 1.0.0) and push again.');
        return { success: false, error: 'Unversioned disabled after versioned release' };
      }
      throw error;
    }
  }
    
  const registryUrl = authManager.getRegistryUrl();
  const profile = authManager.getCurrentProfile(authOptions);
  const versionLabel = formatVersionLabel(versionToPush);
  
  logPushSummary(packageNameToPush, versionLabel, profile, pkg);
  
  // Step 2: Create tarball
  console.log('✓ Creating tarball...');
  const tarballInfo = await createTarballFromPackage(pkg);
  console.log(`✓ Created tarball (${pkg.files.length} files, ${formatFileSize(tarballInfo.size)})`);
  
  // Step 3: Prepare upload data
  const formData = createFormDataForUpload(packageNameToPush, uploadVersion, tarballInfo);
  
  // Step 4: Upload to registry
  const uploadSpinner = new Spinner('Uploading to registry...');
  uploadSpinner.start();
  
  let response: PushPackageResponse;
  try {
    response = await httpClient.uploadFormData<PushPackageResponse>(
      '/packages/push',
      formData
    );
    uploadSpinner.stop();
  } catch (error) {
    uploadSpinner.stop();
    throw error;
  }
  
  // Step 5: Success!
  console.log('✓ Push successful');
  console.log('');
  console.log('✓ Package Details:');
  console.log(`  • Name: ${response.package.name}`);
  console.log(`  • Version: ${response.version.version ?? UNVERSIONED}`);
  console.log(`  • Size: ${formatFileSize(tarballInfo.size)}`);
  const keywords = Array.isArray(response.package.keywords) ? response.package.keywords : [];
  if (keywords.length > 0) {
    console.log(`  • Keywords: ${keywords.join(', ')}`);
  }
  console.log(`  • Private: ${response.package.isPrivate ? 'Yes' : 'No'}`);
  console.log(`  • Created: ${new Date(response.version.createdAt).toLocaleString()}`);
  
  return {
    success: true,
    data: {
      packageName: response.package.name,
      version: response.version.version ?? UNVERSIONED,
      size: tarballInfo.size,
      checksum: tarballInfo.checksum,
      registry: registryUrl,
      profile,
      message: response.message
    }
  };
  
  } catch (error) {
    logger.debug('Push command failed', { error, packageName: packageNameToPush });
    
    // Handle specific error cases
    if (error instanceof Error) {
      const apiError = (error as any).apiError;
      
      if (apiError?.statusCode === 409) {
        console.error(`❌ Version ${attemptedVersion || 'latest'} already exists for package '${packageNameToPush}'`);
        console.log('💡 Try one of these options:');
        console.log('  • Increment version with command "opkg pack <package>"');
        console.log('  • Update version with command "opkg pack <package>@<version>"');
        console.log('  • Specify a version explicitly using <package>@<version>');
        return { success: false, error: 'Version already exists' };
      }
      
      if (apiError?.statusCode === 401) {
        console.error(`❌ Authentication failed: ${error.message}`);
        showApiKeySignupMessage();
        console.log('💡 To configure authentication:');
        console.log('  opkg configure');
        console.log('  opkg configure --profile <name>');
        return { success: false, error: 'Authentication failed' };
      }

      if (apiError?.statusCode === 403) {
        console.error(`❌ Access denied: ${error.message}`);
        showApiKeySignupMessage();
        console.log('💡 To configure authentication:');
        console.log('  opkg configure');
        console.log('  opkg configure --profile <name>');
        return { success: false, error: 'Access denied' };
      }
      
      if (apiError?.statusCode === 422) {
        console.error(`❌ Package validation failed: ${error.message}`);
        if (apiError.details) {
          console.log('Validation errors:');
          if (Array.isArray(apiError.details)) {
            apiError.details.forEach((detail: any) => {
              console.log(`  • ${detail.message || detail}`);
            });
          } else {
            console.log(`  • ${apiError.details}`);
          }
        }
        return { success: false, error: 'Validation failed' };
      }
      
      // Generic error handling (do not print here; global handler will print once)
      
      if (error.message.includes('timeout')) {
        console.log('💡 The upload may have timed out. You can:');
        console.log('  • Try again (the upload may have succeeded)');
        console.log('  • Check your internet connection');
        console.log('  • Set OPENPACKAGEAPI_TIMEOUT environment variable for longer timeout');
      }
      
      return { success: false, error: error.message };
    }
    
    return { success: false, error: 'Unknown error occurred' };
  }
}

/**
 * Setup the push command
 */
export function setupPushCommand(program: Command): void {
  program
    .command('push')
    .description('Push a package to remote registry. Supports package@version syntax.')
    .argument('<package-name>', 'name of the package to push. Supports package@version syntax.')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (packageName: string, options: PushOptions) => {
      const result = await pushPackageCommand(packageName, options);
      if (!result.success) {
        throw new Error(result.error || 'Push operation failed');
      }
    }));
}
