export const piCodingAgentMockState = {
  resourceLoaderOptions: [] as Array<Record<string, unknown>>,
  createAgentSessionInputs: [] as Array<Record<string, unknown>>,
  openedSessionFiles: [] as string[],
  customMessages: [] as Array<{ message: Record<string, unknown>; options: Record<string, unknown> }>,
  prompts: [] as Array<{ text: string; options: Record<string, unknown> }>,
  customTools: [] as Array<Record<string, unknown>>
};

export function resetPiCodingAgentMock(): void {
  piCodingAgentMockState.resourceLoaderOptions = [];
  piCodingAgentMockState.createAgentSessionInputs = [];
  piCodingAgentMockState.openedSessionFiles = [];
  piCodingAgentMockState.customMessages = [];
  piCodingAgentMockState.prompts = [];
  piCodingAgentMockState.customTools = [];
}

export const AuthStorage = {
  create: () => ({})
};

export const ModelRegistry = {
  inMemory: () => ({
    find: (provider: string, id: string) => ({ provider, id })
  })
};

export class DefaultResourceLoader {
  options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    piCodingAgentMockState.resourceLoaderOptions.push(options);
  }

  async reload() {}
}

export class SessionManager {
  static create(cwd: string, sessionDir: string) {
    return { kind: 'created', cwd, sessionDir };
  }

  static open(sessionFile: string) {
    piCodingAgentMockState.openedSessionFiles.push(sessionFile);
    return { kind: 'opened', sessionFile };
  }
}

export function createSyntheticSourceInfo(filePath: string, metadata: Record<string, unknown>) {
  return { filePath, metadata };
}

export function defineTool(tool: Record<string, unknown>) {
  piCodingAgentMockState.customTools.push(tool);
  return tool;
}

export async function createAgentSession(input: Record<string, unknown>) {
  piCodingAgentMockState.createAgentSessionInputs.push(input);
  return {
    session: {
      sessionId: `pi-${piCodingAgentMockState.createAgentSessionInputs.length}`,
      sessionFile: `/tmp/pi-${piCodingAgentMockState.createAgentSessionInputs.length}.json`,
      model: null,
      subscribe() {
        return () => {};
      },
      async sendCustomMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
        piCodingAgentMockState.customMessages.push({ message, options });
      },
      async prompt(text: string, options: Record<string, unknown>) {
        piCodingAgentMockState.prompts.push({ text, options });
      },
      getLastAssistantText() {
        return 'done';
      },
      async setModel() {},
      async compact() {},
      async abort() {},
      dispose() {}
    }
  };
}
