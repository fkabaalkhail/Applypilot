/**
 * Server timestamps are UTC. Some endpoints still serialize them without an
 * offset ("2026-07-08T14:00:00"), and JavaScript reads an offset-less date-time
 * as *local* time, which made a just-uploaded resume render as "-240m ago" for
 * a UTC-4 user. Parse defensively here rather than trusting the wire format.
 */

const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** Parse a server timestamp, treating an offset-less value as UTC. */
export function parseServerDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = NAIVE_ISO.test(value.trim())
    ? `${value.trim().replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * "3m ago", "2 days ago". Clock skew between the browser and the server can put
 * a fresh timestamp slightly in the future; that reads as "just now", never as a
 * negative duration.
 */
export function timeAgo(value: string | null | undefined): string {
  const date = parseServerDate(value);
  if (!date) return "-";

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";

  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "a month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "a year ago" : `${years} years ago`;
}

/** "Jul 8, 2026", for tooltips and anywhere absolute time is clearer. */
export function formatDate(value: string | null | undefined): string {
  const date = parseServerDate(value);
  if (!date) return "-";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
