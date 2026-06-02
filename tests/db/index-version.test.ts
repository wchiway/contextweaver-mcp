import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getIndexVersion, incrementIndexVersion } from '../../src/db/index.js';

describe('index_version metadata', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('defaults to 0 when index_version is missing', () => {
    expect(getIndexVersion(db)).toBe(0);
  });

  it('increments monotonically and persists the new value', () => {
    expect(incrementIndexVersion(db)).toBe(1);
    expect(incrementIndexVersion(db)).toBe(2);
    expect(getIndexVersion(db)).toBe(2);
  });

  it('treats invalid stored values as 0 before incrementing', () => {
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('index_version', 'oops');

    expect(getIndexVersion(db)).toBe(0);
    expect(incrementIndexVersion(db)).toBe(1);
    expect(getIndexVersion(db)).toBe(1);
  });
});
