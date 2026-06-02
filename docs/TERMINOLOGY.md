# Terminology

Use these terms consistently in official package docs, prompts, and package metadata.

## Preferred Terms

- `operator-controlled runtime`
  - The person or team running Moorline controls package activation, provider/transport selection, policy, state, audit, and deployment environment.
- `external surface`
  - A system Moorline connects to through a transport or adapter. Discord is one external surface; GitHub, CI, email, incident tools, and custom APIs can be others.
- `transport`
  - An installable package that connects Moorline to an external surface and emits runtime transport events.
- `provider`
  - An installable package that executes runtime work.
- `plugin`
  - Trusted runtime code that contributes hooks, tools, actions, prompt context, workflow behavior, or integrations.
- `external resource`
  - A normalized outside object associated with runtime work, such as an issue, PR, CI run, email thread, incident, or ticket.
- `work item`
  - Runtime-owned durable package work with status, attempts, idempotency, leases, and optional session/resource binding.
- `package job`
  - Package-owned scheduled action dispatch. Use package jobs for recurring timers; use work items for durable queue/retry/recovery around event-driven work.

## Avoid As Product Identity

- `local-first`
  - Prefer `operator-controlled`, `self-hostable`, or concrete deployment wording.
- `chat-centered`
  - Prefer `event/work orchestration`, `external surface`, or the specific transport name.
- `local runtime code`
  - Prefer `trusted runtime code` or `operator-controlled runtime code`.
