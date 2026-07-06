type OpenCodePageRefreshSource = {
  isFetching: boolean
  refetch: () => unknown
}

type OpenCodeBusinessResponse = {
  success: boolean
  message?: string
}

type OpenCodePageRefreshSources = {
  accounts: OpenCodePageRefreshSource
  channels: OpenCodePageRefreshSource
  diagnostics: OpenCodePageRefreshSource
}

export type OpenCodeAccountDeleteTarget = {
  id: number
  label: string
} | null

export function requireSuccessfulOpenCodeResponse<
  T extends OpenCodeBusinessResponse,
>(response: T | null | undefined, fallbackMessage: string) {
  if (!response?.success) {
    throw new Error(response?.message || fallbackMessage)
  }

  return response
}

export function refreshOpenCodeAccountPageData(
  sources: OpenCodePageRefreshSources
) {
  void sources.accounts.refetch()
  void sources.channels.refetch()
  void sources.diagnostics.refetch()
}

export function isOpenCodeAccountPageRefreshing(
  sources: OpenCodePageRefreshSources
) {
  return (
    sources.accounts.isFetching ||
    sources.channels.isFetching ||
    sources.diagnostics.isFetching
  )
}

export function openCodeAccountWorkspaceGridRows(
  usesFallbackCredentialKey: boolean
) {
  return usesFallbackCredentialKey
    ? 'grid-rows-[auto_minmax(0,1fr)]'
    : 'grid-rows-[minmax(0,1fr)]'
}

export function isOpenCodeAccountDeleteDialogOpen(
  target: OpenCodeAccountDeleteTarget
) {
  return target !== null
}

export function canConfirmOpenCodeAccountDelete(
  target: OpenCodeAccountDeleteTarget,
  isDeleting: boolean
) {
  return target !== null && !isDeleting
}
