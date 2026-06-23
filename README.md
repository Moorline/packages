# Rync Moorline Packages

This repository owns the personal installable Moorline packages: providers, transports, plugins, and bundles.

The host runtime, CLI, contracts, control API, and default HTTP adapter live in `Moorline/moorline`. Package authoring tools live in `Moorline/kit`.

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

`bun run build:personal-npm-packages` generates the public personal npm packages:

- `@rync/moorline-basic-essentials`
- `@rync/moorline-pi`
- `@rync/moorline-discord-default`

Bundle packages embed their member transport and plugin packages so the public npm surface stays focused on user-meaningful install choices. Single installable packages like `rync/pi` are published directly.

Users install these packages through the Moorline CLI or Control API by Moorline package id:

```bash
moorline package search rync
moorline package install rync/basic-essentials --kind bundle
moorline package install rync/discord-default --kind bundle
moorline package install rync/pi --kind provider
```

The npm packages are the distribution and discovery surface. They all carry the shared `moorline-package` keyword, but users should not install runtime packages with `npm install` directly.

## Releases

Publishing is manual for now. The current public npm bundle packages are:

- `@rync/moorline-basic-essentials@0.0.2`
- `@rync/moorline-pi@0.0.2`
- `@rync/moorline-discord@0.0.4`
- `@rync/moorline-discord-runtime@0.0.5`
- `@rync/moorline-discord-default@0.0.5`

The release workflow only builds and smoke-tests artifacts; it does not publish npm packages or upload GitHub release assets.
