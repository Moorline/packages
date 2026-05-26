function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeText(text, fieldName) {
  assert(typeof text === 'string', `${fieldName} must be a string.`);
  const normalized = text.replace(/\s+/g, ' ').trim();
  assert(normalized.length > 0, `${fieldName} must not be empty.`);
  return normalized;
}

function normalizeKey(key, fieldName = 'key') {
  const normalized = normalizeText(key, fieldName);
  assert(/^[a-z0-9][a-z0-9._-]*$/.test(normalized), `${fieldName} must use lowercase letters, numbers, dots, dashes, or underscores.`);
  return normalized;
}

export function parseSoulDocument(content) {
  assert(typeof content === 'string', 'SOUL content must be a string.');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const body = lines.map((line) => line.trimEnd());

  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop();
  }

  assert(body[0] === '# SOUL', 'SOUL.md must start with "# SOUL".');
  const entries = [];
  const seenKeys = new Set();

  for (const line of body.slice(1)) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^(\d+)\.\s+\[([a-z0-9][a-z0-9._-]*)\]\s+(.+)$/);
    assert(match, `Invalid SOUL entry: ${line}`);
    const [, rawIndex, rawKey, rawText] = match;
    const index = Number(rawIndex);
    assert(index === entries.length + 1, `SOUL entry numbering must stay sequential. Expected ${entries.length + 1}, received ${rawIndex}.`);
    assert(!seenKeys.has(rawKey), `Duplicate SOUL key: ${rawKey}`);

    seenKeys.add(rawKey);
    entries.push({
      key: rawKey,
      text: normalizeText(rawText, `SOUL entry ${rawKey}`)
    });
  }

  assert(entries.length > 0, 'SOUL.md must contain at least one entry.');
  return entries;
}

export function stringifySoulDocument(entries) {
  assert(Array.isArray(entries), 'SOUL entries must be an array.');
  const seenKeys = new Set();
  const lines = ['# SOUL', ''];

  entries.forEach((entry, index) => {
    assert(entry && typeof entry === 'object', `SOUL entry ${index + 1} must be an object.`);
    const key = normalizeKey(entry.key);
    const text = normalizeText(entry.text, `SOUL entry ${key}`);
    assert(!seenKeys.has(key), `Duplicate SOUL key: ${key}`);
    seenKeys.add(key);
    lines.push(`${index + 1}. [${key}] ${text}`);
  });

  assert(seenKeys.size > 0, 'SOUL.md must contain at least one entry.');
  return `${lines.join('\n')}\n`;
}

export function replaceSoulEntry(entries, key, text) {
  const normalizedKey = normalizeKey(key);
  const normalizedText = normalizeText(text, `SOUL entry ${normalizedKey}`);
  const nextEntries = parseSoulEntries(entries);
  const index = nextEntries.findIndex((entry) => entry.key === normalizedKey);

  assert(index >= 0, `Unknown SOUL key: ${normalizedKey}`);
  nextEntries[index] = { key: normalizedKey, text: normalizedText };
  return nextEntries;
}

export function insertSoulEntryAfter(entries, afterKey, newKey, text) {
  const normalizedAfterKey = normalizeKey(afterKey, 'after_key');
  const normalizedNewKey = normalizeKey(newKey, 'new_key');
  const normalizedText = normalizeText(text, `SOUL entry ${normalizedNewKey}`);
  const nextEntries = parseSoulEntries(entries);
  const index = nextEntries.findIndex((entry) => entry.key === normalizedAfterKey);

  assert(index >= 0, `Unknown SOUL key: ${normalizedAfterKey}`);
  assert(!nextEntries.some((entry) => entry.key === normalizedNewKey), `SOUL key already exists: ${normalizedNewKey}`);
  nextEntries.splice(index + 1, 0, { key: normalizedNewKey, text: normalizedText });
  return nextEntries;
}

export function removeSoulEntry(entries, key) {
  const normalizedKey = normalizeKey(key);
  const nextEntries = parseSoulEntries(entries);
  const index = nextEntries.findIndex((entry) => entry.key === normalizedKey);

  assert(index >= 0, `Unknown SOUL key: ${normalizedKey}`);
  assert(nextEntries.length > 1, 'SOUL.md must contain at least one entry.');
  nextEntries.splice(index, 1);
  return nextEntries;
}

function parseSoulEntries(entries) {
  return parseSoulDocument(stringifySoulDocument(entries));
}
