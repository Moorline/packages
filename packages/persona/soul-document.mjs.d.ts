export interface SoulEntry {
  key: string;
  text: string;
}

export function parseSoulDocument(content: string): SoulEntry[];
export function stringifySoulDocument(entries: SoulEntry[]): string;
export function replaceSoulEntry(entries: SoulEntry[], key: string, text: string): SoulEntry[];
export function insertSoulEntryAfter(entries: SoulEntry[], afterKey: string, newKey: string, text: string): SoulEntry[];
export function removeSoulEntry(entries: SoulEntry[], key: string): SoulEntry[];
