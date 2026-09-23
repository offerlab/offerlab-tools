/**
 * A real local D1 for the unit tests: Miniflare with the finder's migrations applied. Each test
 * file gets its own database; `dispose()` in afterAll shuts the Miniflare instance down.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

export const TABLES = ['search_brands', 'searches', 'catalogs', 'socials', 'search_history', 'feedback', 'drafts', 'crawl_queue', 'moderation', 'library_bundles'];

// D1's exec() runs one statement per line, so each migration statement is collapsed to a line
// with its comments stripped.
export function migrationStatements() {
  const files = readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort();
  const statements = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/--.*$/gm, '');
    for (const statement of sql.split(';')) {
      const text = statement.replace(/\s+/g, ' ').trim();
      if (text) statements.push(text);
    }
  }
  return statements;
}

export async function createTestDb() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'finder-test' }
  });
  const db = await mf.getD1Database('DB');
  await db.exec(migrationStatements().join('\n'));
  return { mf, db, dispose: () => mf.dispose() };
}

/** Empties every table, so tests in one file start from nothing. */
export async function resetDb(db) {
  await db.batch(TABLES.map(table => db.prepare(`DELETE FROM ${table}`)));
}

/** A stored-search record in the shape the app PUTs, with `n` recommended brands. */
export function searchFixture(domain, n = 2, { products = 1 } = {}) {
  const catalogFor = (host, count) => ({
    status: 'shopify', domain: host, storeUrl: `https://${host}`, count,
    products: Array.from({ length: count }, (_, i) => ({
      id: `${host}-${i}`, title: `Product ${i}`, image: `https://${host}/p${i}.jpg`, price: 10 + i, url: `https://${host}/products/p${i}`
    }))
  });
  return {
    type: 'results',
    searchId: `search-${domain}`,
    searchedBrand: { name: domain, url: `https://${domain}`, description: `${domain} sells things`, catalog: catalogFor(domain, products) },
    brands: Array.from({ length: n }, (_, i) => {
      const host = `partner${i + 1}-${domain}`;
      return { name: `Partner ${i + 1}`, url: `https://${host}`, reasons: ['fits'], bundleIdea: 'a box', catalog: catalogFor(host, products) };
    }),
    serpApiOutOfCredits: false
  };
}
