import { createFileRoute, redirect } from '@tanstack/react-router'

import { OpenCodeAccounts } from '@/features/opencode-accounts'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/opencode-accounts/')({
  beforeLoad: () => {
    const { auth } = useAuthStore.getState()

    if (!auth.user || auth.user.role < ROLE.SUPER_ADMIN) {
      throw redirect({
        to: '/403',
      })
    }
  },
  component: OpenCodeAccounts,
})
