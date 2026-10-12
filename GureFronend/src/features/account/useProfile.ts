import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchProfile, patchProfile } from './api/account.api'
import type { Profile, ProfilePatch } from './api/account.api'

export const PROFILE_KEY = ['account', 'profile'] as const

export const useProfile = () => useQuery({ queryKey: PROFILE_KEY, queryFn: fetchProfile })

// Every section of the account page saves through this: it sends the profile's current version, and the answer
// becomes the new cached profile (so the next save carries the new version). The sign-in profile (theme, avatar) is
// refetched so the rest of the app follows.
export function useSaveProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ patch, version }: { patch: ProfilePatch; version: string }) => patchProfile(patch, version),
    onSuccess: (profile: Profile) => {
      queryClient.setQueryData(PROFILE_KEY, profile)
      void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}
