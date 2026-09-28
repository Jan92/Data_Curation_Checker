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
  const response = await fetchAsset(relativePath);
  return response.text();
}

/** Fetch a binary asset (Excel workbook) relative to the application base href. */
export async function fetchBinaryAsset(relativePath: string): Promise<Uint8Array> {
  const response = await fetchAsset(relativePath);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchAsset(relativePath: string): Promise<Response> {
  const url = new URL(relativePath.replace(/^\//, ''), document.baseURI).toString();
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Could not load asset "${relativePath}" (${response.status} ${response.statusText}).`);
  }
  return response;
}
