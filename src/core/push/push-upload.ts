import { PACKAGE_PATHS } from '../../constants/index.js';
import type { PushPackageResponse } from '../../types/api.js';
import { formatFileSize } from '../../utils/formatters.js';
import type { HttpClient } from '../../utils/http-client.js';
import { normalizePathForProcessing } from '../../utils/path-normalization.js';
import { Spinner } from '../../utils/spinner.js';
import { createFormDataForUpload, createTarballFromPackage } from '../../utils/tarball.js';
import type { PushMode } from './push-types.js';

export function buildPushPayload(
  pkg: any,
  mode: PushMode,
  requestedPaths: string[]
): any {
  return mode === 'partial' ? buildPartialTarballPackage(pkg, requestedPaths) : pkg;
}

export async function createPushTarball(pkg: any) {
  console.log('✓ Creating tarball...');
  const tarballInfo = await createTarballFromPackage(pkg);
  console.log(`✓ Created tarball (${pkg.files.length} files, ${formatFileSize(tarballInfo.size)})`);
  return tarballInfo;
}

export async function uploadPackage(
  httpClient: HttpClient,
  packageName: string,
  uploadVersion: string | undefined,
  tarballInfo: Awaited<ReturnType<typeof createTarballFromPackage>>
): Promise<PushPackageResponse> {
  const formData = createFormDataForUpload(packageName, uploadVersion, tarballInfo);
  const uploadSpinner = new Spinner('Uploading to registry...');
  return withSpinner(uploadSpinner, () =>
    httpClient.uploadFormData<PushPackageResponse>('/packages/push', formData)
  );
}

export function buildPartialTarballPackage(
  pkg: any,
  requestedPaths: string[]
): any {
  const manifestPath = normalizePathForProcessing(PACKAGE_PATHS.MANIFEST_RELATIVE);
  const manifest = pkg.files.find((file: { path: string }) =>
    normalizePathForProcessing(file.path) === manifestPath
  );
  if (!manifest) {
    throw new Error('package.yml not found in local registry');
  }

  const requestedSet = new Set(
    requestedPaths
      .map((path) => normalizePathForProcessing(path))
      .map((path) => (path.startsWith('/') ? path.slice(1) : path))
  );
  const selectedFiles = pkg.files.filter((file: { path: string }) =>
    requestedSet.has(normalizePathForProcessing(file.path))
  );

  return {
    metadata: pkg.metadata,
    files: [...selectedFiles, manifest],
  };
}

async function withSpinner<T>(spinner: Spinner, fn: () => Promise<T>): Promise<T> {
  spinner.start();
  try {
    return await fn();
  } finally {
    spinner.stop();
  }
}

