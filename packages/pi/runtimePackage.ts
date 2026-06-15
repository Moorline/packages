import manifest from './manifest.json' with { type: 'json' };
import {
  type ProviderPackageManifest,
  type RuntimeProviderPackage,
  validateProviderPackageManifest
} from '@moorline/contracts';
import { PiProviderService } from './providerService.js';

const packageManifest = validateProviderPackageManifest(manifest as ProviderPackageManifest);

function agentDirFromConfig(config: Record<string, unknown> | undefined): string | undefined {
  const value = typeof config?.agentDir === 'string' ? config.agentDir.trim() : '';
  return value || undefined;
}

const runtimePackage: RuntimeProviderPackage = {
  manifest: packageManifest,
  createProviderFactory(input) {
    const agentDir = agentDirFromConfig(input.config);
    return () => new PiProviderService({ packageId: packageManifest.id, agentDir });
  },
  createEnvironmentVerifier() {
    return async () => {
      await import('@earendil-works/pi-coding-agent');
    };
  }
};

export default runtimePackage;
