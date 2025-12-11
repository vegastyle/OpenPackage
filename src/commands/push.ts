import { Command } from 'commander';

import type { CommandResult, PushOptions } from '../types/index.js';
import { withErrorHandling } from '../utils/errors.js';
import { runPushPipeline } from '../core/push/push-pipeline.js';
import { parsePathsOption } from '../utils/registry-paths.js';

async function pushPackageCommand(
  packageInput: string,
  options: PushOptions
): Promise<CommandResult> {
  return runPushPipeline(packageInput, options);
}

export function setupPushCommand(program: Command): void {
  program
    .command('push')
    .description('Push a package to remote registry. Supports package@version syntax.')
    .argument('<package-name>', 'name of the package to push. Supports package@version syntax.')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .option('--registry <url>', 'push to custom registry (uses first specified registry, must be remote URL)', (value: string, previous: string[]) => {
      return previous ? [...previous, value] : [value];
    }, [] as string[])
    .option('--no-default-registry', 'only use specified registries (exclude default remote)')
    .option('--paths <list>', 'comma-separated registry paths for partial push', parsePathsOption)
    .action(withErrorHandling(async (packageName: string, options: PushOptions) => {
      const result = await pushPackageCommand(packageName, options);
      if (!result.success) {
        throw new Error(result.error || 'Push operation failed');
      }
    }));
}
