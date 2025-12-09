import { logger } from '../../utils/logger.js';
import { showApiKeySignupMessage } from '../../utils/messages.js';
import { PackageNotFoundError, UserCancellationError } from '../../utils/errors.js';
import type { PushCommandResult } from './push-types.js';

export class PushError extends Error {
  constructor(
    message: string,
    public readonly code?: 'INVALID_VERSION' | 'PRERELEASE_DISALLOWED' | 'NO_VERSIONS'
  ) {
    super(message);
    this.name = 'PushError';
  }
}

export function handlePushError(
  error: unknown,
  packageName: string,
  attemptedVersion?: string,
  requestedVersion?: string
): PushCommandResult {
  logger.debug('Push pipeline failed', { error, packageName });

  if (error instanceof UserCancellationError) {
    throw error;
  }

  if (error instanceof PackageNotFoundError) {
    const versionLabel = requestedVersion ?? attemptedVersion ?? 'requested version';
    console.error(`❌ Version ${versionLabel} not found for package '${packageName}'`);
    console.log('💡 Create this stable version using "opkg pack <package>" and push again.');
    return { success: false, error: 'Version not found' };
  }

  if (error instanceof PushError) {
    if (error.code === 'INVALID_VERSION') {
      console.error(`❌ ${error.message}`);
      return { success: false, error: 'Invalid version' };
    }
    if (error.code === 'PRERELEASE_DISALLOWED') {
      console.error(`❌ ${error.message}`);
      console.log('Only stable versions (x.y.z) can be pushed to the remote registry.');
      console.log('💡 Create a stable version using "opkg pack <package>".');
      return { success: false, error: 'Only stable versions can be pushed' };
    }
    if (error.code === 'NO_VERSIONS') {
      console.error(`❌ ${error.message}`);
      return { success: false, error: 'Version not found' };
    }

    console.error(`❌ ${error.message}`);
    return { success: false, error: error.message };
  }

  if (error instanceof Error) {
    const apiError = (error as any).apiError;

    if (apiError?.statusCode === 409) {
      console.error(`❌ Version ${attemptedVersion || 'latest'} already exists for package '${packageName}'`);
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
      const apiMessage = apiError.message || error.message || 'Validation failed';
      console.error(`❌ Package validation failed: ${apiMessage}`);

      if (apiError.details) {
        const detailsArray = Array.isArray(apiError.details) ? apiError.details : [apiError.details];
        console.log('Validation errors:');
        detailsArray.forEach((detail: any) => {
          if (typeof detail === 'string') {
            console.log(`  • ${detail}`);
            return;
          }
          if (detail?.message) {
            console.log(`  • ${detail.message}`);
            return;
          }
          if (detail?.constraints && typeof detail.constraints === 'object') {
            console.log(`  • ${Object.values(detail.constraints).join(', ')}`);
            return;
          }
          console.log(`  • ${JSON.stringify(detail)}`);
        });
      } else if (apiError) {
        console.log('Validation error detail (raw):');
        console.log(`  • ${JSON.stringify(apiError)}`);
      }

      return { success: false, error: apiMessage };
    }

    if (apiError) {
      const apiMessage = apiError.message || error.message || 'Request failed';
      console.error(`❌ Request failed (${apiError.statusCode ?? 'unknown status'}): ${apiMessage}`);
      if (apiError.error) {
        console.log(`  • code: ${apiError.error}`);
      }
      if (apiError.details) {
        const detailsArray = Array.isArray(apiError.details) ? apiError.details : [apiError.details];
        detailsArray.forEach((detail: any) => {
          if (typeof detail === 'string') {
            console.log(`  • ${detail}`);
            return;
          }
          if (detail?.message) {
            console.log(`  • ${detail.message}`);
            return;
          }
          if (detail?.constraints && typeof detail.constraints === 'object') {
            console.log(`  • ${Object.values(detail.constraints).join(', ')}`);
            return;
          }
          console.log(`  • ${JSON.stringify(detail)}`);
        });
      } else {
        console.log(`  • raw: ${JSON.stringify(apiError)}`);
      }
      return { success: false, error: apiMessage };
    }

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

