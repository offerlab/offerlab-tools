// One page, rendered by the Worker on every request (no prerender: the OAuth redirect and the
// search state live in the query string) and hydrated in the browser, where everything happens.
export const prerender = false;
export const ssr = true;
export const trailingSlash = 'never';
