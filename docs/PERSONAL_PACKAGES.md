# Rync Moorline Packages

This repo owns the personal provider, transport, plugin, skill, and bundle packages.

Typical package setup:

```bash
moorline package search discord
moorline package info rync/discord-default --kind bundle
moorline package install rync/discord-default --kind bundle
moorline package install rync/codex-default --kind bundle
moorline configure package select --surface transport --package rync/discord
moorline configure package select --surface provider --package rync/codex
moorline configure package config --surface transport --package rync/discord --key authToken --value <token>
moorline configure package config --surface transport --package rync/discord --key scopeId --value <scope-id>
moorline configure package config --surface provider --package rync/codex --key command --value codex
moorline configure apply
```

Discord package notes:

- `rync/discord` needs a Discord bot token and a scope/server id.
- Verification may derive package-owned metadata such as application id, actor id, and invite permissions. Those values belong to the package config payload, not the Moorline host config schema.
- The Discord package creates and repairs only its Moorline-managed surface.

Codex package notes:

- `rync/codex` shells out to the configured Codex command.
- Run `codex login status` before starting provider-backed sessions.
- Runtime modes are selected by Moorline and passed through the provider contract.

Missions package notes:

- `rync/missions` owns recurring objectives as package state and package jobs.
- Missions create and direct normal Moorline sessions; the host does not have a special mission surface.

Bundle notes:

- `rync/discord-default`, `rync/codex-default`, and `rync/basic-essentials` are user-meaningful bundle packages.
- Bundle members are embedded in npm bundle packages or resolved through package source metadata.
- Package discovery uses npm metadata; this repo does not publish a host-consumed rync catalog artifact.
