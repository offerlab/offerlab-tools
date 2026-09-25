import { test, expect } from '@playwright/test';

// One stored search per project: the desktop and phone runs seed and read at the same time.
const domainFor = (project) => `smoke-brand-${project}.test`;

// A catalog with one Shopify product: that is what makes a result card buildable.
function catalog(host) {
  return {
    status: 'shopify', domain: host, storeUrl: `https://${host}`, count: 1,
    products: [{ id: `${host}-1`, title: `${host} product`, image: `https://${host}/p.jpg`, price: 12, url: `https://${host}/products/p` }]
  };
}

const storedSearch = (domain) => ({
  type: 'results',
  searchId: 'smoke-search',
  searchedBrand: { name: 'Smoke Brand', url: `https://${domain}`, description: 'A brand for the smoke test.', catalog: catalog(domain) },
  brands: [
    { name: 'Partner One', url: 'https://partner-one.test', reasons: ['Same kitchen moment', 'Same customer'], bundleIdea: 'A starter box', catalog: catalog('partner-one.test') },
    { name: 'Partner Two', url: 'https://partner-two.test', reasons: ['Same gift occasion'], bundleIdea: 'A gift set', catalog: catalog('partner-two.test') }
  ],
  serpApiOutOfCredits: false
});

test('the landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Collab/);
  await expect(page.locator('#searchInput')).toBeVisible();
  await expect(page.locator('#floatingTiles')).toHaveCount(1);
});

test('the showcase renders its tiles', async ({ page }) => {
  await page.goto('/?view=library');
  await expect(page.locator('#librarySection')).toBeVisible();
  await expect(page.locator('.library-tile').first()).toBeVisible();
});

test('a stored search renders results and opens the picker', async ({ page, request }, testInfo) => {
  const domain = domainFor(testInfo.project.name);
  // The page hands out the session the API's gate asks for, when a signing key is set.
  await request.get('/');
  const stored = await request.put(`/api/data/searches/${encodeURIComponent(domain)}`, {
    headers: { 'Content-Type': 'application/json' },
    data: storedSearch(domain)
  });
  expect(stored.ok(), await stored.text()).toBeTruthy();

  await page.goto(`/?q=${encodeURIComponent(domain)}`);
  await expect(page.locator('#resultsSection')).toBeVisible();
  await expect(page.locator('.result-card')).toHaveCount(2);

  await page.locator('.build-bundle-btn').first().click();
  await expect(page.locator('#pickerSection')).toBeVisible();
  await expect(page.locator('.picker-column').first()).toBeVisible();
});
