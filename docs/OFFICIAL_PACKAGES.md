# Official Moorline Packages

This repo owns the first-party provider, transport, plugin, skill, and bundle packages.

Typical package setup:

```bash
moorline package search discord
moorline package info official/discord-default --kind bundle
moorline package install official/discord-default --kind bundle
moorline package install official/codex-default --kind bundle
moorline configure package select --surface transport --package official/discord
moorline configure package select --surface provider --package official/codex
moorline configure package config --surface transport --package official/discord --key authToken --value <token>
moorline configure package config --surface transport --package official/discord --key scopeId --value <scope-id>
moorline configure package config --surface provider --package official/codex --key command --value codex
moorline configure apply
```

Discord package notes:

- `official/discord` needs a Discord bot token and a scope/server id.
- Verification may derive package-owned metadata such as application id, actor id, and invite permissions. Those values belong to the package config payload, not the Moorline host config schema.
- The Discord package creates and repairs only its Moorline-managed namespace.

Codex package notes:

- `official/codex` shells out to the configured Codex command.
- Run `codex login status` before starting provider-backed sessions.
- Runtime modes are selected by Moorline and passed through the provider contract.

Bundle notes:

- `official/discord-default`, `official/codex-default`, and `official/basic-essentials` are user-meaningful bundle packages.
- Bundle members are embedded in npm bundle packages or resolved through package source metadata.
- Package discovery uses npm metadata; this repo does not publish a host-consumed official catalog artifact.
