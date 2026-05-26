import manifest from './manifest.json' with { type: 'json' };
import {
  type RuntimeTransportConfigCompletionInput,
  type RuntimeTransportConfigCompletionResult,
  type RuntimeTransportPackage,
  type TransportPackageManifest,
  validateTransportPackageManifest
} from '@moorline/contracts';
import { DiscordTransportAdapter } from './adapter/discordTransportAdapter.js';
import { REQUIRED_DISCORD_PERMISSIONS } from './adapter/discordInstaller.js';

const packageManifest = validateTransportPackageManifest(manifest as TransportPackageManifest);

const runtimePackage: RuntimeTransportPackage = {
  manifest: packageManifest,
  async completeConfig(input: RuntimeTransportConfigCompletionInput): Promise<RuntimeTransportConfigCompletionResult> {
    const authToken = typeof input.config.authToken === 'string' ? input.config.authToken.trim() : '';
    const scopeId = typeof input.config.scopeId === 'string' ? input.config.scopeId.trim() : '';
    if (!authToken) {
      throw new Error('Discord bot token is required.');
    }
    if (!scopeId) {
      throw new Error('Discord server ID is required.');
    }

    const verification = await new DiscordTransportAdapter().verifyAccess({
      authToken,
      scopeId
    });
    if (!verification.applicationId) {
      throw new Error('Discord application ID could not be derived from the bot token.');
    }

    const nextConfig = {
      ...input.config,
      authToken,
      scopeId: verification.scopeId,
      applicationId: verification.applicationId,
      actorId: verification.actorId,
      invitePermissions: REQUIRED_DISCORD_PERMISSIONS
    };

    const warnings = ([
      ['scopeId', verification.scopeId],
      ['applicationId', verification.applicationId],
      ['actorId', verification.actorId],
      ['invitePermissions', REQUIRED_DISCORD_PERMISSIONS]
    ] as const)
      .filter(([key, value]) => {
        const previous = input.config[key];
        return typeof previous === 'string' && previous.trim().length > 0 && previous !== value;
      })
      .map(([key]) => `Discord ${key} was replaced with the token-derived setup value.`);

    return {
      config: nextConfig,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  },
  createTransport() {
    return new DiscordTransportAdapter();
  }
};

export default runtimePackage;
