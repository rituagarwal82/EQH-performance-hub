import { queryOptions } from "@tanstack/react-query";

import { getFeedScreen, getVerdict } from "./verdict.functions";

export const verdictQuery = () =>
  queryOptions({
    queryKey: ["verdict"],
    queryFn: () => getVerdict(),
    staleTime: 60_000,
  });

export const feedScreenQuery = () =>
  queryOptions({
    queryKey: ["feed-screen"],
    queryFn: () => getFeedScreen(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
