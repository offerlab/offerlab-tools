import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, migrationStatements, TABLES } from './helpers/d1.js';

describe('the D1 test helper', () => {
  let ctx;
  beforeAll(async () => { ctx = await createTestDb(); });
  afterAll(() => ctx.dispose());

  it('collapses the migrations into one statement per line', () => {
    const statements = migrationStatements();
    expect(statements.length).toBeGreaterThan(10);
    expect(statements.every(s => !s.includes('\n') && !s.includes('--'))).toBe(true);
  });

  it('applies every table', async () => {
    const { results } = await ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const names = results.map(row => row.name);
    for (const table of TABLES) expect(names).toContain(table);
  });
});
