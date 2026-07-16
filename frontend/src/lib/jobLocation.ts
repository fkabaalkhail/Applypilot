/** Mirror of backend location_display for jobs carrying locations_json. */

export interface JobLocationEntry {
  city?: string;
  region?: string;
  region_name?: string;
  country?: string;
}

export function displayLocation(job: {
  location?: string | null;
  locations_json?: JobLocationEntry[] | null;
}): string {
  const locs = job.locations_json || [];
  if (locs.length === 0) {
    return (job.location || "").split(";")[0].trim();
  }
  const head = locs[0];
  const parts = [head.city, head.region || head.region_name, head.country].filter(Boolean);
  const label = parts.join(", ");
  return locs.length > 1 ? `${label} · +${locs.length - 1} more` : label;
}
