import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    // Extract URL and params
    const url = queryKey[0] as string;
    const params = queryKey[1] as Record<string, any> | undefined;
    
    // Construct URL with query params if needed
    let finalUrl = url;
    if (params) {
      // For custom dates, force the year to 2025 to match server expectations
      if (params.startDate && params.endDate) {
        const startDate = new Date(params.startDate);
        const endDate = new Date(params.endDate);
        
        // Force the year to 2025
        if (startDate.getFullYear() !== 2025) {
          startDate.setFullYear(2025);
        }
        if (endDate.getFullYear() !== 2025) {
          endDate.setFullYear(2025);
        }
        
        // Create URLSearchParams with corrected dates
        const searchParams = new URLSearchParams();
        searchParams.append('startDate', startDate.toISOString());
        searchParams.append('endDate', endDate.toISOString());
        finalUrl = `${url}?${searchParams.toString()}`;
        
        console.log('Making API request with CORRECTED dates:', {
          url: finalUrl,
          correctedStartDate: startDate.toISOString(),
          correctedEndDate: endDate.toISOString()
        });
      } else {
        // Standard query params handling
        const searchParams = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
          searchParams.append(key, String(value));
        });
        finalUrl = `${url}?${searchParams.toString()}`;
      }
    }
    
    const res = await fetch(finalUrl, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
