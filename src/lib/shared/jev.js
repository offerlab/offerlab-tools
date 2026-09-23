/**
 * Jev (TypeSafe's System One model) decides which recommended brands are worth a search of their
 * own. It answers three narrow questions about one candidate; code owns the thresholds, the
 * ranking and every cap. https://docs.typesafe.ai
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

// A candidate is crawled only when it clears all three. Measured on 41 recommendations from three
// stored searches (DEPLOYMENT.md): own products is the noisy one, so its floor only drops
// catalogs of other sellers' listings.
export const JEV_THRESHOLDS = {
  brand: 0.6,       // probability the candidate is a consumer brand, not a store, service or media
  ownProducts: 0.3, // probability its sample products carry its own brand
  fit: 1.5          // expected fit level, 0-3
};

const QUESTIONS = {
  kind: {
    type: 'choice',
    instructions: 'What kind of business the candidate is',
    criteria: {
      consumer_brand: 'A brand that makes and sells its own consumer products',
      retailer: 'A store or marketplace that sells many other brands\' products',
      service: 'A service, app, software, meal plan or subscription box of other brands\' products',
      media: 'A publication, agency, creator, event or venue'
    }
  },
  own_products: {
    type: 'noul',
    instructions: 'The candidate\'s sample products carry the candidate\'s own brand'
  },
  fit: {
    type: 'score',
    instructions: 'How well the candidate\'s products would sit in one bundle with the searched brand\'s products, bought by the same customer',
    criteria: [
      'No believable bundle',
      'A stretch',
      'A good bundle',
      'An obvious, strong bundle'
    ]
  }
};

const SAMPLE_PRODUCTS = 8;

/** The text Jev reads: the searched brand, then the candidate as the search described it. */
export function candidateState(searchedBrand, candidate) {
  const products = (candidate.catalog?.products || []).slice(0, SAMPLE_PRODUCTS).map(p => p.title).filter(Boolean);
  return JSON.stringify({
    searched_brand: {
      name: searchedBrand?.name || null,
      description: searchedBrand?.description || null
    },
    candidate: {
      name: candidate.name,
      website: candidate.url,
      why_recommended: candidate.reasons || [],
      bundle_idea: candidate.bundleIdea || null,
      sample_products: products
    }
  }, null, 2);
}

/** Jev's answers for one candidate, or throws. `fetchImpl` is for tests. */
export async function askJev(apiKey, state, { fetchImpl = (...args) => fetch(...args), model = JEV_MODEL } = {}) {
  const response = await fetchImpl(JEV_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model, questions: QUESTIONS })
  });
  if (!response.ok) throw new Error(`Jev answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

/**
 * `{ crawl, score, reason, answers }`. `score` ranks the candidates that pass: expected fit,
 * weighted by how sure Jev is that this is a brand at all.
 */
export function judge(result, thresholds = JEV_THRESHOLDS) {
  const answers = result?.answers || {};
  const brand = answers.kind?.probabilities?.consumer_brand ?? 0;
  const ownProducts = answers.own_products?.noul ?? 0;
  const fit = answers.fit?.score ?? 0;
  const summary = {
    model: result?.model || null,
    kind: answers.kind?.choice || null,
    brand: round(brand),
    ownProducts: round(ownProducts),
    fit: round(fit)
  };
  let reason = 'passed';
  if (brand < thresholds.brand) reason = `not a brand (${summary.kind})`;
  else if (ownProducts < thresholds.ownProducts) reason = 'products are not its own';
  else if (fit < thresholds.fit) reason = 'weak fit';
  return { crawl: reason === 'passed', score: round(fit * brand), reason, answers: summary };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
