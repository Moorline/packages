import manifest from './manifest.json' with { type: 'json' };
import {
  type ProviderPackageManifest,
  type RuntimeProviderPackage,
  validateProviderPackageManifest
} from '@moorline/contracts';
import { CodexAdapter } from './codexAdapter.js';
import { detectCodexAuthStatus, detectCodexInstallation, type CommandRunner } from './codexCli.js';
import { CodexAppServerManager } from './codexAppServerManager.js';
import { ProviderService } from './providerService.js';

const packageManifest = validateProviderPackageManifest(manifest as ProviderPackageManifest);

function codexCommandFromConfig(config: Record<string, unknown> | undefined): string {
  const command = typeof config?.command === 'string' ? config.command.trim() : '';
  return command || 'codex';
}

const runtimePackage: RuntimeProviderPackage = {
  manifest: packageManifest,
  createProviderFactory(input) {
    const codexCommand = codexCommandFromConfig(input.config);
    return () => new ProviderService(new CodexAppServerManager(), new CodexAdapter(), codexCommand);
  },
  createEnvironmentVerifier(input) {
    const commandRunner = input.commandRunner as CommandRunner | undefined;
    if (!commandRunner) {
      return null;
    }
    const codexCommand = codexCommandFromConfig(input.config);
    return async () => {
      const installation = await detectCodexInstallation(commandRunner, codexCommand);
      if (!installation.installed) {
        throw new Error(`Codex CLI is required before runtime start: ${installation.detail}`);
      }
      const auth = await detectCodexAuthStatus(commandRunner, codexCommand);
      if (!auth.authenticated) {
        throw new Error(`Codex auth is required before runtime start: ${auth.detail}`);
      }
    };
  }
};

export default runtimePackage;
