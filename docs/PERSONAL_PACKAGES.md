# Rync Moorline Packages

This repo owns the personal provider, transport, plugin, and bundle packages.

Typical package setup:

```bash
moorline package search discord
moorline package info rync/discord-default --kind bundle
moorline package install rync/discord-default --kind bundle
moorline package install rync/pi --kind provider
moorline configure package select --surface transport --package rync/discord
moorline configure package select --surface provider --package rync/pi
moorline configure package config --surface transport --package rync/discord --key authToken --value <token>
moorline configure package config --surface transport --package rync/discord --key scopeId --value <server-id>
moorline configure package config --surface provider --package rync/pi --key agentDir --value ~/.pi/agent
moorline configure apply
```

Discord package notes:

- `rync/discord` needs a Discord bot token and a scope/server id.
- Verification may derive package-owned metadata such as application id, actor id, and invite permissions.
- The Discord package creates or repairs only `moorline-start`; project categories and session channels are user-owned Discord state.

Pi package notes:

- `rync/pi` embeds the Pi SDK through `@earendil-works/pi-coding-agent`.
- Configure Pi auth/model settings in the normal Pi agent directory before starting provider-backed sessions.
- Runtime modes are selected by Moorline and passed through the provider contract.

Bundle notes:

- `rync/discord-default` and `rync/basic-essentials` are user-meaningful bundle packages.
- `rync/pi` is a single provider package and does not need a wrapper bundle.
- `rync/discord-default` embeds the Discord transport and one Discord runtime plugin rather than many tiny Discord command packages.
- Bundle members are embedded in npm bundle packages or resolved through package source metadata.
- Package discovery uses npm metadata; this repo does not publish a host-consumed rync catalog artifact.
