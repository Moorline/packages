import type { RuntimeCommandRunner } from '@moorline/contracts';
export type CommandRunner = RuntimeCommandRunner;

interface CodexInstallationStatus {
  installed: boolean;
  version: string | null;
  detail: string;
}

interface CodexAuthStatus {
  authenticated: boolean;
  strategy: 'chatgpt' | 'api_key' | 'unknown' | 'none';
  detail: string;
}

function trimOutput(value: string): string {
  return value.trim();
}

export async function detectCodexInstallation(
  runner: CommandRunner,
  command = 'codex'
): Promise<CodexInstallationStatus> {
  const result = await runner.run(command, ['--version']);
  if (result.exitCode !== 0) {
    return {
      installed: false,
      version: null,
      detail: trimOutput(result.stderr || result.stdout) || `${command} is not available`
    };
  }

  return {
    installed: true,
    version: trimOutput(result.stdout) || 'unknown',
    detail: trimOutput(result.stdout) || `${command} is installed`
  };
}

export async function detectCodexAuthStatus(runner: CommandRunner, command = 'codex'): Promise<CodexAuthStatus> {
  const result = await runner.run(command, ['login', 'status']);
  const output = trimOutput(`${result.stdout}\n${result.stderr}`);
  if (result.exitCode !== 0) {
    return {
      authenticated: false,
      strategy: 'none',
      detail: output || 'Codex auth check failed'
    };
  }

  const normalized = output.toLowerCase();
  if (normalized.includes('logged in using chatgpt')) {
    return {
      authenticated: true,
      strategy: 'chatgpt',
      detail: trimOutput(result.stdout) || 'Logged in using ChatGPT'
    };
  }

  if (normalized.includes('api key')) {
    return {
      authenticated: true,
      strategy: 'api_key',
      detail: trimOutput(result.stdout) || 'Logged in using API key'
    };
  }

  if (normalized.includes('not logged in')) {
    return {
      authenticated: false,
      strategy: 'none',
      detail: trimOutput(result.stdout) || 'Not logged in'
    };
  }

  return {
    authenticated: true,
    strategy: 'unknown',
    detail: trimOutput(result.stdout) || 'Codex login status is available'
  };
}
