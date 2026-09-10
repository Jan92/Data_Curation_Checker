/**
 * Browser asset loader for DCC configs and sample datasets.
 *
 * Resolves paths against `document.baseURI` so the same relative paths work
 * under any Angular `base-href` (local serve and GitHub Pages).
 */

/**
 * Fetch a text asset relative to the application base href.
 * @throws Error when the HTTP response is not OK.
 */
export async function fetchTextAsset(relativePath: string): Promise<string> {
  const url = new URL(relativePath.replace(/^\//, ''), document.baseURI).toString();
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Could not load asset "${relativePath}" (${response.status} ${response.statusText}).`);
  }
  return response.text();
}
