import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpStatusError } from './rateLimiter';
import { BoundedFetchError, fetchBoundedText } from './httpFetcher';

// One shared bounded fetcher (audit finding 18): every adapter routes through
// it, so these cases pin the contract a caller relies on: a 404 is "no data",
// a non-OK status is a typed failure, and an oversized response fails one
// request instead of reading without bound.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBoundedText', () => {
  it('returns decoded text for a normal response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello')));
    await expect(fetchBoundedText('https://example.com/page')).resolves.toBe('hello');
  });

  it('returns empty text for HTTP 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
    await expect(fetchBoundedText('https://example.com/missing')).resolves.toBe('');
  });

  it('throws HttpStatusError for a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    await expect(fetchBoundedText('https://example.com/forbidden')).rejects.toBeInstanceOf(
      HttpStatusError,
    );
  });

  it('refuses a response whose Content-Length exceeds the cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('small', { headers: { 'content-length': '5000' } })),
    );
    const error = await fetchBoundedText('https://example.com/big', { maxBytes: 10 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BoundedFetchError);
    expect((error as BoundedFetchError).failure).toBe('responseTooLarge');
  });

  it('refuses a streamed body that grows past the cap without Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('abcdefghijklmnopqrstuvwxyz')),
    );
    await expect(
      fetchBoundedText('https://example.com/stream', { maxBytes: 10 }),
    ).rejects.toMatchObject({ name: 'BoundedFetchError', failure: 'responseTooLarge' });
  });
});
