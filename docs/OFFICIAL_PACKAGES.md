# Official Moorline Packages

This repo owns the first-party provider, transport, plugin, skill, and bundle packages.

Official packages are normal installable packages. They should demonstrate Moorline's extension boundaries: transports connect external surfaces, providers execute agent work, plugins add trusted runtime behavior, skills contribute instructions, and bundles compose package selections.

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
- Discord is one transport shape. Official Discord chat/session plugins should not imply that chat is Moorline's architectural center.

Codex package notes:

- `official/codex` shells out to the configured Codex command.
- Run `codex login status` before starting provider-backed sessions.
- Runtime modes are selected by Moorline and passed through the provider contract.

Missions package notes:

- `official/missions` owns recurring objectives as package state and package jobs.
- Missions create and direct normal Moorline sessions; the host does not have a special mission surface.
- Missions intentionally use package jobs because they are scheduled recurring objectives. Event-driven packages should prefer host-owned work items once they need idempotency, leases, retries, or resource/session binding.

Event/work package notes:

- Packages that react to GitHub, CI, email, incident, or similar non-chat events should use `external.event.received` and `onExternalEvent` rather than pretending those events are chat messages.
- Packages with durable event-driven work should use `package.work.manage` work items instead of hand-rolled active/seen queues in package state.
- Packages that need deterministic readiness checks should record gates with runtime gate APIs instead of leaving readiness entirely in prompts.
- Packages that need one-shot assessment should use session-backed headless runs when available, and keep provider-specific process spawning inside provider packages.

Bundle notes:

- `official/discord-default`, `official/codex-default`, and `official/basic-essentials` are user-meaningful bundle packages.
- Bundle members are embedded in npm bundle packages or resolved through package source metadata.
- Package discovery uses npm metadata; this repo does not publish a host-consumed official catalog artifact.
