import { useQuery } from '@tanstack/react-query'
import { fetchOptions } from '../api/masters.api'

// Active rows of another master as select options. The server caches the dropdown list for 10 minutes and purges it
// on every write, so a short client cache is enough.
export function useOptions(path: string | undefined) {
  return useQuery({
    queryKey: ['masters', 'options', path],
    queryFn: () => fetchOptions(path!),
    enabled: Boolean(path),
    staleTime: 60_000,
  })
}
