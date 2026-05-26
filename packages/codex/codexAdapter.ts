import type { ProviderRuntimeEvent } from '@moorline/contracts';

export class CodexAdapter {
  normalize(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
    return event;
  }
}
