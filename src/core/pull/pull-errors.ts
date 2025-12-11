import type { CommandResult } from '../../types/index.js';
import type { RemotePullFailure } from '../remote-pull.js';

export function handleMetadataFailure(
  failure: RemotePullFailure,
  packageName: string,
  requestedVersion?: string
): CommandResult {
  switch (failure.reason) {
    case 'not-found':
      console.error(`❌ Package '${packageName}' not found in registry`);
      if (requestedVersion) {
        console.log(`Version '${requestedVersion}' does not exist.`);
      } else {
        console.log('Package does not exist in the registry.');
      }
      console.log('');
      console.log('💡 Try one of these options:');
      console.log('  • Check the package name spelling');
      console.log('  • Use opkg search to find available packages');
      console.log('  • Verify you have access to this package if it\'s private');
      return { success: false, error: 'Package not found' };
    case 'access-denied':
      console.error(failure.message);
      console.log('');
      if (failure.statusCode === 403) {
        console.log('💡 This may be a private package. Ensure you have VIEWER permissions.');
      }
      console.log('💡 To configure authentication:');
      console.log('  opkg configure');
      console.log('  opkg configure --profile <name>');
      return { success: false, error: 'Access denied' };
    case 'network':
      console.log('');
      console.log('💡 Try one of these options:');
      console.log('  • Check your internet connection');
      console.log('  • Try again (temporary network issue)');
      console.log('  • Set OPENPACKAGEAPI_TIMEOUT environment variable for longer timeout');
      return { success: false, error: 'Download failed' };
    case 'integrity':
      console.error(`❌ Package integrity verification failed: ${failure.message}`);
      console.log('');
      console.log('💡 The downloaded package may be corrupted. Try pulling again.');
      return { success: false, error: 'Integrity verification failed' };
    default:
      return { success: false, error: failure.message };
  }
}

export function handleUnexpectedError(error: unknown, packageName: string, requestedVersion?: string): CommandResult {
  if (error && typeof error === 'object' && 'success' in error) {
    return handleMetadataFailure(error as RemotePullFailure, packageName, requestedVersion);
  }

  if (error instanceof Error) {
    return handleMetadataFailure({
      success: false,
      reason: 'unknown',
      message: error.message,
      error
    }, packageName, requestedVersion);
  }

  return handleMetadataFailure({
    success: false,
    reason: 'unknown',
    message: 'Unknown error occurred',
    error
  }, packageName, requestedVersion);
}


