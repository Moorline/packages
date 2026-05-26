const DEFAULT_REDACTED_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /cookie/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /credential/i,
  /bearer/i
];

interface RedactPayloadOptions {
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
  redactedKeyPatterns?: RegExp[];
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 14))}...(truncated)`;
}

function redactValue(value: unknown, depth: number, options: Required<RedactPayloadOptions>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value, options.maxStringLength);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const trimmed = value.slice(0, options.maxArrayLength).map((entry) => redactValue(entry, depth + 1, options));
    if (value.length > options.maxArrayLength) {
      trimmed.push(`[${value.length - options.maxArrayLength} additional entries truncated]`);
    }
    return trimmed;
  }
  if (typeof value !== 'object') return String(value);
  if (depth >= options.maxDepth) return '[object truncated]';

  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const key of Object.keys(record).slice(0, options.maxObjectKeys)) {
    redacted[key] = options.redactedKeyPatterns.some((pattern) => pattern.test(key))
      ? '[REDACTED]'
      : redactValue(record[key], depth + 1, options);
  }
  if (Object.keys(record).length > options.maxObjectKeys) {
    redacted.__truncatedKeys = Object.keys(record).length - options.maxObjectKeys;
  }
  return redacted;
}

export function redactPayloadForLogs(value: unknown, options: RedactPayloadOptions = {}): unknown {
  return redactValue(value, 0, {
    maxDepth: options.maxDepth ?? 4,
    maxArrayLength: options.maxArrayLength ?? 10,
    maxObjectKeys: options.maxObjectKeys ?? 20,
    maxStringLength: options.maxStringLength ?? 200,
    redactedKeyPatterns: options.redactedKeyPatterns ?? DEFAULT_REDACTED_KEY_PATTERNS
  });
}

interface KeyedDrainableWorkerOptions {
  maxPendingPerKey?: number;
  maxPendingTotal?: number;
}

export class KeyedDrainableWorker {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pendingByKey = new Map<string, number>();
  private pendingTotal = 0;
  private readonly maxPendingPerKey: number;
  private readonly maxPendingTotal: number;

  constructor(
    readonly name: string,
    options: KeyedDrainableWorkerOptions = {}
  ) {
    this.maxPendingPerKey = options.maxPendingPerKey ?? 256;
    this.maxPendingTotal = options.maxPendingTotal ?? 4_096;
  }

  push<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pendingForKey = this.pendingByKey.get(key) ?? 0;
    if (pendingForKey >= this.maxPendingPerKey || this.pendingTotal >= this.maxPendingTotal) {
      return Promise.reject(new Error(`${this.name} rejected work for key ${key}: queue depth limit exceeded.`));
    }
    this.pendingByKey.set(key, pendingForKey + 1);
    this.pendingTotal += 1;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, settled);
    void settled.finally(() => {
      const latest = this.pendingByKey.get(key) ?? 0;
      if (latest <= 1) this.pendingByKey.delete(key);
      else this.pendingByKey.set(key, latest - 1);
      this.pendingTotal = Math.max(0, this.pendingTotal - 1);
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return run;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}

const BASE_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'SSH_AUTH_SOCK',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy'
]);

const PREFIX_ALLOWLIST = ['MOORLINE_', 'CODEX_'];

export function buildChildProcessEnv(input: {
  explicit?: Record<string, string | undefined>;
  additionalAllowlist?: string[];
} = {}): Record<string, string | undefined> {
  const allowed = new Set([...BASE_ENV_ALLOWLIST, ...(input.additionalAllowlist ?? [])]);
  for (const key of (process.env.MOORLINE_CHILD_ENV_ALLOWLIST ?? '').split(',')) {
    if (key.trim()) allowed.add(key.trim());
  }

  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (allowed.has(key) || PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix)))) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(input.explicit ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
