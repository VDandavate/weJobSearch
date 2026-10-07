// Shared HTTP request timeout for scraper fetches (Phase 7c, SDD
// Requirement 8). All six source adapters plus the rate limiter's own
// robots.txt fetch abort via AbortSignal.timeout with this single value, so a
// future retune lands in one place instead of seven copy-pasted literals.

export const defaultRequestTimeoutMs = 15000;
