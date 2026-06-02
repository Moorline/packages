# Moorline Official Packages

This repository owns the official installable Moorline packages: providers, transports, plugins, skills, and bundles.

These packages extend Moorline as an operator-controlled event/work orchestration runtime. Discord chat, Codex-backed sessions, scheduled missions, memory, skills, and lifecycle controls are official package examples, not privileged host features.

The host runtime, CLI, contracts, control API, and default HTTP adapter live in `Moorline/moorline`. Package authoring tools live in `Moorline/kit`; official-package terminology lives in `docs/TERMINOLOGY.md`.

## Development

The public development path consumes the published host contracts and package kit:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test:fast
bun run build
```

For cross-repo runtime changes, clone the repos side-by-side and build the host and kit packages first:

```text
moorline/
  moorline/
  kit/
  packages/
```

```sh
cd moorline
bun install --frozen-lockfile
bun run --filter '@moorline/contracts' build
cd ../kit
bun install --frozen-lockfile
bun run build:packages
cd ../packages
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test:fast
bun run build
```

`bun run build` generates installable archives in `dist/installable-archives`. Published npm package metadata is the package discovery surface.

`bun run build:official-npm-packages` generates only the public official bundle npm packages for now:

- `@moorline/basic-essentials`
- `@moorline/codex-default`
- `@moorline/discord-default`

Those bundle packages embed their member provider, transport, and plugin packages so the public npm surface stays focused on user-meaningful install choices.

## Releases

Publishing is manual for now. The initial public npm bundle packages are:

- `@moorline/basic-essentials@0.0.1`
- `@moorline/codex-default@0.0.1`
- `@moorline/discord-default@0.0.1`

The release workflow only builds and smoke-tests artifacts; it does not publish npm packages or upload GitHub release assets.
