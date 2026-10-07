import type { ApplicationRecord } from './jobFunnelTracker';

export const defaultStalenessWindowDays = 45;

export interface StalenessCheckOptions {
  windowDays?: number;
  referenceDate?: Date;
}

const millisecondsPerDay = 24 * 60 * 60 * 1000;

export function lastUpdateTimestampOf(record: ApplicationRecord): string | null {
  if (record.statusHistory.length === 0) {
    return null;
  }
  // F7/U45: only well-formed timestamps participate in the max. A malformed
  // entry previously won the lexicographic reduce and masked earlier valid
  // entries (or produced NaN downstream, which silently reads as "not
  // stale"). Malformed entries are ignored; when none parse, there is no
  // trustworthy recency signal and the caller treats the record as not stale.
  // Phase D: ordering is by parsed time value, not lexicographic string
  // order — non-ISO but parseable dates (for example '08/18/2026') sort by
  // their instant, since their lexical order is chronological nonsense.
  const valid = record.statusHistory.filter((entry) => !Number.isNaN(Date.parse(entry.timestamp)));
  if (valid.length === 0) {
    return null;
  }
  return valid.reduce(
    (latest, entry) => (Date.parse(entry.timestamp) > Date.parse(latest) ? entry.timestamp : latest),
    valid[0].timestamp,
  );
}

function daysBetween(referenceDate: Date, earlierTimestamp: string): number {
  const elapsedMs = referenceDate.getTime() - Date.parse(earlierTimestamp);
  return Math.floor(elapsedMs / millisecondsPerDay);
}

export function isStale(record: ApplicationRecord, options: StalenessCheckOptions = {}): boolean {
  if (record.status !== 'appliedConfirmed') {
    return false;
  }
  const lastUpdateTimestamp = lastUpdateTimestampOf(record);
  if (lastUpdateTimestamp === null) {
    return false;
  }
  const windowDays = options.windowDays ?? defaultStalenessWindowDays;
  const referenceDate = options.referenceDate ?? new Date();
  return daysBetween(referenceDate, lastUpdateTimestamp) >= windowDays;
}
