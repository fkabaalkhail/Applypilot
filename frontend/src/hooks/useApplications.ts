/**
 * React Query hook for application data — auto-refreshes every 30 seconds.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchApplications, fetchStats } from "../api";

export function useApplications(filters?: Record<string, string>) {
  return useQuery({
    queryKey: ["applications", filters],
    queryFn: () => fetchApplications(filters),
    refetchInterval: 30_000,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: 30_000,
  });
}
