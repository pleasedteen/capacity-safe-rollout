/**
 * Append-only JSONL journal with fsync — the controller's durable state.
 * On boot the journal is replayed to rebuild the in-memory rollout record.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface JournalEntry {
  ts: number;
  type: string;
  [k: string]: unknown;
}

export class Journal {
  private fd: number;
  readonly file: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'journal.jsonl');
    this.fd = fs.openSync(this.file, 'a');
  }

  append(entry: Omit<JournalEntry, 'ts'>): void {
    const line = JSON.stringify({ ...entry, ts: Date.now() }) + '\n';
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
  }

  readAll(): JournalEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8');
    const out: JournalEntry[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as JournalEntry);
      } catch {
        // tolerate a torn last line after a hard crash
      }
    }
    return out;
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}
