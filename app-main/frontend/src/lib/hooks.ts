import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiGet } from "@/lib/api";
import type { AirportRef, FlightDetail, FlightEvent, FlightsResponse, Ground, GroundSummary, User } from "@/lib/types";

import { tr, trServer } from "@/lib/i18n";
export function errMsg(e: unknown): string {
  if (e instanceof ApiError) {
    const d = (e.body as { detail?: unknown } | null)?.detail;
    if (typeof d === "string") return trServer(d);
    if (Array.isArray(d) && d[0]?.msg) return tr("Données invalides : {0}", [d[0].msg]);
    if (e.status >= 500) return tr("Erreur serveur. Réessayez.");
    return tr("Erreur {0}", [e.status]);
  }
  return tr("Serveur injoignable. Vérifiez votre connexion.");
}

export const useMe = () =>
  useQuery<User>({
    queryKey: ["me"],
    queryFn: () => apiGet<User>("/auth/me"),
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
    staleTime: 30_000,
  });

export const useFlights = (scope: "active" | "all" | "mine" = "active") =>
  useQuery<FlightsResponse>({
    queryKey: ["flights", scope],
    queryFn: () => apiGet<FlightsResponse>(`/flights?scope=${scope}`),
    refetchInterval: 2000,
  });

export const useFlight = (id: string | null | undefined) =>
  useQuery<FlightDetail>({
    queryKey: ["flight", id],
    queryFn: () => apiGet<FlightDetail>(`/flights/${id}`),
    enabled: !!id,
    refetchInterval: 2000,
  });

export const useFlightEvents = (id: string | null | undefined) =>
  useQuery<FlightEvent[]>({
    queryKey: ["flight-events", id],
    queryFn: () => apiGet<FlightEvent[]>(`/flights/${id}/events`),
    enabled: !!id,
    refetchInterval: 4000,
  });

/** Real ground data (OpenStreetMap). First load of an airport can take up to ~1 min (Overpass). */
export const useGround = (icao: string | null | undefined) =>
  useQuery<Ground>({
    queryKey: ["ground", icao],
    queryFn: () => apiGet<Ground>(`/airports/${icao}/ground`),
    enabled: !!icao && /^[A-Z0-9]{4}$/.test(icao),
    staleTime: 10 * 60_000,
    retry: 1,
  });

/** Airports around the map centre (zoom >= 12): their ground plan loads automatically, for every airport. */
export function useNearbyGrounds(center: [number, number] | null, zoom: number) {
  const on = !!center && zoom >= 12;
  // ~1 km grid: small pans reuse the same answer
  const key = on ? `${center![0].toFixed(2)},${center![1].toFixed(2)}` : null;
  const near = useQuery<AirportRef[]>({
    queryKey: ["nearby", key],
    queryFn: () => apiGet<AirportRef[]>(`/airports/nearby?lat=${center![0]}&lon=${center![1]}&radius_nm=8&limit=2`),
    enabled: on,
    staleTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });
  const codes = on ? (near.data ?? []).map((a) => a.icao) : [];
  const grounds = useQueries({
    queries: codes.map((icao) => ({
      queryKey: ["ground", icao],
      queryFn: () => apiGet<Ground>(`/airports/${icao}/ground`),
      staleTime: 10 * 60_000,
      retry: 1,
    })),
  });
  return {
    grounds: grounds.map((g) => g.data).filter((g): g is Ground => !!g),
    loading: codes.filter((_, i) => grounds[i]?.isLoading),
    failed: codes.filter((_, i) => grounds[i]?.isError),
  };
}

export const useLoadedAirports = () =>
  useQuery<GroundSummary[]>({ queryKey: ["airports"], queryFn: () => apiGet<GroundSummary[]>("/airports"), staleTime: 30_000 });

/** Mutation on a flight: writes the server's answer to the cache and refreshes lists + history. */
export function useFlightMutation(flightId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<FlightDetail, unknown, { fn: () => Promise<FlightDetail>; success?: string }>({
    mutationFn: ({ fn }) => fn(),
    onSuccess: (data, vars) => {
      qc.setQueryData(["flight", flightId], data);
      if (vars.success) toast.success(vars.success);
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["flight", flightId] });
      qc.invalidateQueries({ queryKey: ["flight-events", flightId] });
      qc.invalidateQueries({ queryKey: ["flights"] });
    },
  });
}
