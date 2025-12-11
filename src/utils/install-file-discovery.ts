import { packageManager } from '../core/package.js';
import { FILE_PATTERNS, PACKAGE_PATHS } from '../constants/index.js';
import type { PackageFile } from '../types/index.js';
import { getPlatformDefinition, type Platform } from '../core/platforms.js';
import { buildNormalizedIncludeSet, isManifestPath, normalizePackagePath } from './manifest-paths.js';

export interface CategorizedInstallFiles {
  pathBasedFiles: PackageFile[];
  rootFiles: Map<string, string>;
}

export async function discoverAndCategorizeFiles(
  packageName: string,
  version: string,
  platforms: Platform[],
  includePaths?: string[]
): Promise<CategorizedInstallFiles> {
  // Load once
  const pkg = await packageManager.loadPackage(packageName, version);

  const normalizedIncludes = buildNormalizedIncludeSet(includePaths);

  const shouldInclude = (path: string): boolean =>
    !normalizedIncludes || normalizedIncludes.has(normalizePackagePath(path));

  // Precompute platform root filenames
  const platformRootNames = new Set<string>();
  for (const platform of platforms) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile) platformRootNames.add(def.rootFile);
  }

  // Single pass classification
  const pathBasedFiles: PackageFile[] = [];
  const rootFiles = new Map<string, string>();
  for (const file of pkg.files) {
    const p = file.path;
    // Never install registry package metadata files
    if (isManifestPath(p) || normalizePackagePath(p) === PACKAGE_PATHS.INDEX_RELATIVE) continue;
    if (!shouldInclude(p)) continue;

    pathBasedFiles.push(file);

    if (p === FILE_PATTERNS.AGENTS_MD || platformRootNames.has(p)) {
      rootFiles.set(p, file.content);
    }
  }

  return { pathBasedFiles, rootFiles };
}


