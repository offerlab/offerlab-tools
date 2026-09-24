// Queues domains for the server-side crawl, or shows the queue. One domain per line in the file;
// blank lines and # comments are skipped. Needs CRAWL_SECRET in the environment (or a file
// passed with --env-file), and CRAWL_ORIGIN for a deployment other than production.
//   CRAWL_SECRET=... npm run crawl -- domains.txt [--refresh]
//   CRAWL_SECRET=... npm run crawl -- --status
import { readFileSync } from 'fs';

const origin = process.env.CRAWL_ORIGIN || 'https://collabfinder.offerlab.com';
const secret = process.env.CRAWL_SECRET;
if (!secret) {
  console.error('CRAWL_SECRET is not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };

if (args.includes('--status')) {
  const status = await (await fetch(`${origin}/api/crawl`, { headers })).json();
  console.log(JSON.stringify(status, null, 2));
} else {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: npm run crawl -- domains.txt [--refresh] | --status');
    process.exit(1);
  }
  const domains = readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const response = await fetch(`${origin}/api/crawl`, {
    method: 'POST', headers, body: JSON.stringify({ domains, refresh: args.includes('--refresh') })
  });
  const body = await response.json();
  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${body.error}`);
    process.exit(1);
  }
  console.log(`Queued ${body.queued.length} domains. The scheduler searches them a minute at a time.`);
}
