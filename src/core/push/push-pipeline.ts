import { UNVERSIONED } from '../../constants/index.js';
import { authManager } from '../auth.js';
import { ensureRegistryDirectories } from '../directory.js';
import { packageManager } from '../package.js';
import { createHttpClient } from '../../utils/http-client.js';
import { logger } from '../../utils/logger.js';
import { normalizePathForProcessing } from '../../utils/path-normalization.js';
import {
  ensureScopedPackageName,
  resolvePushResolution,
  resolvePushRequestContext,
  validateUploadVersion,
} from './push-context.js';
import { handlePushError } from './push-errors.js';
import { logPushSummary, printPushSuccess } from './push-output.js';
import { buildPushPayload, createPushTarball, uploadPackage } from './push-upload.js';
import type { PushCommandResult, PushPipelineOptions } from './push-types.js';

export async function runPushPipeline(
  packageInput: string,
  options: PushPipelineOptions
): Promise<PushCommandResult> {
  const cwd = process.cwd();
  const authOptions = { profile: options.profile, apiKey: options.apiKey };

  const requestContext = resolvePushRequestContext(packageInput, options.paths);

  let packageNameToPush = requestContext.parsedName;
  let attemptedVersion: string | undefined;

  try {
    logger.info(`Pushing package '${packageInput}' to remote registry`, { options });
    await ensureRegistryDirectories();

    if (!(await packageManager.packageExists(packageNameToPush))) {
      console.error(`❌ Package '${packageNameToPush}' not found in local registry`);
      return { success: false, error: 'Package not found' };
    }

    await authManager.validateAuth(authOptions);
    packageNameToPush = await ensureScopedPackageName(cwd, packageNameToPush, authOptions);

    const { pkg, versionToPush } = await resolvePushResolution(
      packageNameToPush,
      requestContext.parsedVersion
    );
    attemptedVersion = versionToPush;

    if (requestContext.mode === 'partial') {
      const missing = findMissingPaths(pkg, requestContext.requestedPaths);
      if (missing.length > 0) {
        missing.forEach((path) =>
          console.error(`❌ Path '${path}' not found in local registry for '${packageNameToPush}'`)
        );
        return { success: false, error: 'Requested path not found in local registry' };
      }
    }

    validateUploadVersion(versionToPush);

    const httpClient = await createHttpClient(authOptions);
    const registryUrl = authManager.getRegistryUrl();
    const profile = authManager.getCurrentProfile(authOptions);
    logPushSummary({
      packageName: packageNameToPush,
      profile,
      registryUrl,
      pkg,
      mode: requestContext.mode,
      requestedPaths: requestContext.requestedPaths,
    });

    const payload = buildPushPayload(pkg, requestContext.mode, requestContext.requestedPaths);
    const tarballInfo = await createPushTarball(payload);
    const response = await uploadPackage(httpClient, packageNameToPush, versionToPush, tarballInfo);

    printPushSuccess(response, tarballInfo, registryUrl);

    return {
      success: true,
      data: {
        packageName: response.package.name,
        version: response.version.version ?? UNVERSIONED,
        size: tarballInfo.size,
        checksum: tarballInfo.checksum,
        registry: registryUrl,
        profile,
        message: response.message,
      },
    };
  } catch (error) {
    return handlePushError(error, packageNameToPush, attemptedVersion, requestContext.parsedVersion);
  }
}

function findMissingPaths(pkg: any, requestedPaths: string[]): string[] {
  const normalizedFiles = new Set(
    pkg.files.map((file: { path: string }) => normalizePathForProcessing(file.path))
  );
  return requestedPaths.filter((path) => !normalizedFiles.has(normalizePathForProcessing(path)));
}

