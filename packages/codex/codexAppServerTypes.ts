import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type readline from 'node:readline';
import type {
  ProviderInputImage,
  ProviderRuntimeEvent,
  ProviderSessionRecord,
  RuntimeModeName
} from '@moorline/contracts';
import type { PendingApproval, PendingUserInput } from './codexAppServerEventMapping.js';

export interface PendingCall {
  method: string;
  cleanup(): void;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface SessionContext {
  session: ProviderSessionRecord;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  nextRequestId: number;
  pending: Map<number, PendingCall>;
  pendingApprovals: Map<string, PendingApproval>;
  pendingUserInputs: Map<string, PendingUserInput>;
  stopping: boolean;
  finalized: boolean;
}

export interface CodexAppServerStartSessionInput {
  threadId: string;
  runtimeMode: RuntimeModeName;
  cwd: string;
  codexCommand: string;
  runtimeRoot: string;
  transportResourceId: string;
  surface: 'coordination' | 'session';
  model?: string;
  codexHomePath?: string;
  resumeCursor?: {
    threadId: string;
  };
}

export interface CodexAppServerSendTurnInput {
  threadId: string;
  input: {
    text: string;
    images?: ProviderInputImage[];
  };
  model?: string;
}

export interface CodexAppServerManagerEvents {
  event: [event: ProviderRuntimeEvent];
}

export const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
export const MIN_STARTUP_REQUEST_TIMEOUT_MS = 1_500;
export const CODEX_PROVIDER_PACKAGE_ID = 'rync/codex';

export class CodexAppServerRequestTimeoutError extends Error {
  readonly code = 'CODEX_APP_SERVER_REQUEST_TIMEOUT';

  constructor(
    readonly method: string,
    readonly timeoutMs: number
  ) {
    super(`codex app-server request "${method}" timed out after ${timeoutMs}ms.`);
    this.name = 'CodexAppServerRequestTimeoutError';
  }
}

type AppServerInputItem =
  | {
      type: 'text';
      text: string;
      text_elements: string[];
    }
  | {
      type: 'local_image';
      path: string;
    }
  | {
      type: 'image';
      url: string;
    };

export function toAppServerInputItems(input: { text: string; images?: ProviderInputImage[] }): AppServerInputItem[] {
  return [
    {
      type: 'text',
      text: input.text,
      text_elements: []
    },
    ...((input.images ?? []).map((image) =>
      'localPath' in image
        ? {
            type: 'local_image' as const,
            path: image.localPath
          }
        : {
            type: 'image' as const,
            url: image.url
          }
    ))
  ];
}
