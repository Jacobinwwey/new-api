import { createFileRoute, redirect } from '@tanstack/react-router'
import z from 'zod'

import { OpenCodeRemoteBrowserWindow } from '@/features/opencode-accounts/remote-browser-window'
import { getSelf } from '@/lib/api'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

const opencodeBrowserSearchSchema = z.object({
  account_id: z.coerce.number().int().positive().optional().catch(undefined),
})

export const Route = createFileRoute('/opencode-browser')({
  validateSearch: opencodeBrowserSearchSchema,
  beforeLoad: async ({ location }) => {
    const { auth } = useAuthStore.getState()
    let user = auth.user

    if (!user) {
      const res = await getSelf().catch(() => null)
      if (res?.success && res.data) {
        user = res.data
        auth.setUser(res.data)
      }
    }

    if (!user) {
      throw redirect({
        to: '/sign-in',
        search: { redirect: location.href },
      })
    }

    if (user.role < ROLE.SUPER_ADMIN) {
      throw redirect({
        to: '/403',
      })
    }
  },
  component: OpenCodeBrowserRouteComponent,
})

function OpenCodeBrowserRouteComponent() {
  const { account_id } = Route.useSearch()

  return <OpenCodeRemoteBrowserWindow initialAccountID={account_id ?? null} />
}
