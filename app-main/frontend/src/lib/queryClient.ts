import { QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

// Exported so lib/session can wipe it at session boundaries — cached data outlives logout.
// Any 401 (expired/revoked session) re-checks /auth/me so the shell redirects to /login once.
export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (err instanceof ApiError && err.status === 401 && query.queryKey[0] !== "me") {
        queryClient.invalidateQueries({ queryKey: ["me"] });
      }
    },
  }),
});
