// One bounded HTTP fetcher for every source adapter (audit finding 31).
// It owns the shared User-Agent/Accept headers and timeout, and enforces a
// per-response byte cap from Content-Length when present and from a streaming
// byte count otherwise. An oversized or unreadable response throws a typed
// BoundedFetchError, so a caller's per-source or per-posting isolation turns
// it into one failed source/posting instead of an unbounded read.
import { HttpStatusError } from './rateLimiter';
import { defaultRequestTimeoutMs } from './requestTimeout';
import { scraperUserAgent } from './userAgent';

export const defaultMaxResponseBytes = 5 * 1024 * 1024;
// Job-listings sitemaps are the largest response in the scrape path (~2.5 MB
// gzipped each); this cap leaves headroom while still bounding the read.
export const maxSitemapResponseBytes = 8 * 1024 * 1024;

export type BoundedFetchFailure = 'responseTooLarge' | 'responseReadFailed';

export class BoundedFetchError extends Error {
  readonly failure: BoundedFetchFailure;
  readonly url: string;
  readonly maxBytes: number | null;

  constructor(
    failure: BoundedFetchFailure,
    url: string,
    message: string,
    maxBytes: number | null = null,
  ) {
    super(message);
    this.name = 'BoundedFetchError';
    this.failure = failure;
    this.url = url;
    this.maxBytes = maxBytes;
  }
}

export interface BoundedFetchOptions {
  maxBytes?: number;
  // Merged over the shared headers; used for source-specific Accept or
  // X-Requested-With values.
  headers?: Record<string, string>;
}

const sharedHeaders: Record<string, string> = {
  'User-Agent': scraperUserAgent,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function readBoundedBody(
  response: Response,
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel();
      throw new BoundedFetchError(
        'responseTooLarge',
        url,
        `Response from ${url} declares ${declaredBytes} bytes, over the ${maxBytes}-byte cap`,
        maxBytes,
      );
    }
  }

  if (response.body === null) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new BoundedFetchError(
        'responseTooLarge',
        url,
        `Response from ${url} exceeded the ${maxBytes}-byte cap`,
        maxBytes,
      );
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BoundedFetchError(
          'responseTooLarge',
          url,
          `Response from ${url} exceeded the ${maxBytes}-byte cap`,
          maxBytes,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BoundedFetchError || isTimeoutLike(error)) {
      throw error;
    }
    throw new BoundedFetchError(
      'responseReadFailed',
      url,
      `Response body from ${url} could not be read: ${(error as Error).message}`,
      maxBytes,
    );
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// Raw response bytes, or null for HTTP 404 (callers treat that as "no data",
// preserving every adapter's existing behavior).
export async function fetchBoundedBytes(
  url: string,
  options: BoundedFetchOptions = {},
): Promise<Uint8Array | null> {
  const response = await fetch(url, {
    headers: { ...sharedHeaders, ...options.headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(defaultRequestTimeoutMs),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new HttpStatusError(
      response.status,
      `Request to ${url} failed with status ${response.status}`,
    );
  }
  return readBoundedBody(response, url, options.maxBytes ?? defaultMaxResponseBytes);
}

// UTF-8 decoded text, or '' for HTTP 404.
export async function fetchBoundedText(
  url: string,
  options: BoundedFetchOptions = {},
): Promise<string> {
  const bytes = await fetchBoundedBytes(url, options);
  return bytes === null ? '' : new TextDecoder('utf-8').decode(bytes);
}
