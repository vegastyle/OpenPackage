import { join } from 'path';
import { PackageYml } from '../types/index.js';
import { getRegistryDirectories } from './directory.js';
import { authManager } from './auth.js';
import { parsePackageYml } from '../utils/package-yml.js';
import { exists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { createHttpClient } from '../utils/http-client.js';

/**
 * Registry configuration
 */
export interface RegistryConfig {
  url: string;
  type: 'local' | 'remote';
  priority: number;
}

/**
 * Result of a package search
 */
export interface PackageSearchResult {
  metadata: PackageYml;
  source: RegistryConfig;
}

/**
 * Registry resolution and search across multiple registries
 */
export class RegistryResolver {
  /**
   * Resolve registries based on options
   */
  resolveRegistries(options: {
    customRegistries?: string[];
    noDefaultRegistry?: boolean;
    localOnly?: boolean;
    remoteOnly?: boolean;
  }): RegistryConfig[] {
    const registries: RegistryConfig[] = [];
    let priority = 0;

    // 1. Add custom registries (highest priority)
    if (options.customRegistries && options.customRegistries.length > 0) {
      for (const url of options.customRegistries) {
        const type = this.detectRegistryType(url);

        // Apply local/remote filter
        if (options.localOnly && type !== 'local') continue;
        if (options.remoteOnly && type !== 'remote') continue;

        registries.push({ url, type, priority: priority++ });
      }
    }

    // 2. Add defaults (unless excluded)
    if (!options.noDefaultRegistry) {
      // Default local
      if (!options.remoteOnly) {
        const { packages: localRegistry } = getRegistryDirectories();
        registries.push({
          url: localRegistry,
          type: 'local',
          priority: priority++
        });
      }

      // Default remote
      if (!options.localOnly) {
        const remoteUrl = authManager.getRegistryUrl();
        registries.push({
          url: remoteUrl,
          type: 'remote',
          priority: priority++
        });
      }
    }

    logger.debug('Resolved registries', {
      registries: registries.map(r => ({ url: r.url, type: r.type, priority: r.priority })),
      options
    });

    return registries;
  }

  /**
   * Detect if registry is local (directory) or remote (URL)
   */
  detectRegistryType(url: string): 'local' | 'remote' {
    // URL patterns (http://, https://)
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return 'remote';
    }

    // IP address pattern (e.g., 192.168.1.100:3000)
    if (/^\d+\.\d+\.\d+\.\d+(:\d+)?/.test(url)) {
      return 'remote';
    }

    // Everything else is local directory path
    return 'local';
  }

  /**
   * Search package across multiple registries
   * Uses graceful fallback - continues to next registry on failure
   */
  async searchPackage(
    packageName: string,
    version: string | undefined,
    registries: RegistryConfig[]
  ): Promise<PackageSearchResult | null> {
    logger.debug(`Searching for ${packageName}${version ? `@${version}` : ''} across ${registries.length} registries`);

    // Search in priority order
    for (const registry of registries) {
      try {
        logger.debug(`Trying registry: ${registry.url} (${registry.type})`);

        const metadata = await this.getPackageFromRegistry(
          packageName,
          version,
          registry
        );

        if (metadata) {
          logger.debug(`Package found in registry: ${registry.url}`);
          return { metadata, source: registry };
        }
      } catch (error) {
        // Graceful fallback - log and continue
        logger.debug(`Package not found in registry ${registry.url}: ${error}`);
        continue;
      }
    }

    logger.debug(`Package ${packageName}${version ? `@${version}` : ''} not found in any registry`);
    return null;
  }

  /**
   * Get package from specific registry
   */
  private async getPackageFromRegistry(
    packageName: string,
    version: string | undefined,
    registry: RegistryConfig
  ): Promise<PackageYml | null> {
    if (registry.type === 'local') {
      return await this.getFromLocalRegistry(packageName, version, registry.url);
    } else {
      return await this.getFromRemoteRegistry(packageName, version, registry.url);
    }
  }

  /**
   * Get package from local registry
   */
  private async getFromLocalRegistry(
    packageName: string,
    version: string | undefined,
    registryPath: string
  ): Promise<PackageYml | null> {
    // Use existing local registry logic
    const versionToUse = version || 'latest';
    const packagePath = join(registryPath, packageName, versionToUse);
    const packageYmlPath = join(packagePath, 'package.yml');

    if (!(await exists(packageYmlPath))) {
      return null;
    }

    return await parsePackageYml(packageYmlPath);
  }

  /**
   * Get package from remote registry
   */
  private async getFromRemoteRegistry(
    packageName: string,
    version: string | undefined,
    registryUrl: string
  ): Promise<PackageYml | null> {
    // Create HTTP client with custom registry URL
    const httpClient = await createHttpClient(undefined, registryUrl);

    // Construct URL
    const versionPath = version || 'latest';
    const url = `${registryUrl}/packages/${packageName}/${versionPath}/metadata`;

    try {
      const packageYml = await httpClient.get<PackageYml>(url);
      return packageYml;
    } catch (error: any) {
      // 404 means package not found - return null for graceful fallback
      if (error.response?.status === 404 || error.status === 404) {
        return null;
      }

      // Other errors - rethrow for logging
      throw error;
    }
  }

  /**
   * Validate that a registry is accessible
   */
  async validateRegistry(registry: RegistryConfig): Promise<boolean> {
    if (registry.type === 'local') {
      // Check directory exists and has valid structure
      const dirExists = await exists(registry.url);
      if (!dirExists) {
        logger.warn(`Local registry not found: ${registry.url}`);
        return false;
      }
      return true;
    } else {
      // Try to ping remote registry health endpoint
      try {
        const httpClient = await createHttpClient(undefined, registry.url);
        await httpClient.get(`${registry.url}/health`);
        return true;
      } catch (error) {
        logger.warn(`Remote registry unreachable: ${registry.url}`);
        return false;
      }
    }
  }
}

/**
 * Singleton instance
 */
export const registryResolver = new RegistryResolver();
