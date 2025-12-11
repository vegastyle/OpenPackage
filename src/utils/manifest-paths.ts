import { FILE_PATTERNS, PACKAGE_PATHS } from '../constants/index.js';
import { normalizePathForProcessing } from './path-normalization.js';

/**
 * Normalize package-internal paths for consistent comparisons.
 * Strips leading slash and converts to forward slashes.
 */
export function normalizePackagePath(path: string): string {
  const trimmed = path.startsWith('/') ? path.slice(1) : path;
  return normalizePathForProcessing(trimmed);
}

/**
 * Determine if a path points to a package manifest (either bare or canonical).
 */
export function isManifestPath(path: string): boolean {
  const normalized = normalizePackagePath(path);
  return (
    normalized === FILE_PATTERNS.PACKAGE_YML ||
    normalized === PACKAGE_PATHS.MANIFEST_RELATIVE
  );
}

/**
 * Build a normalized include set (or null if empty) for registry path filtering.
 */
export function buildNormalizedIncludeSet(paths: string[] | undefined): Set<string> | null {
  if (!paths || paths.length === 0) return null;
  return new Set(paths.map(normalizePackagePath));
}

