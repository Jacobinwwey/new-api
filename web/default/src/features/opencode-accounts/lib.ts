type OpenCodePageRefreshSource = {
  isFetching: boolean
  refetch: () => unknown
}

type OpenCodePageRefreshSources = {
  accounts: OpenCodePageRefreshSource
  channels: OpenCodePageRefreshSource
  diagnostics: OpenCodePageRefreshSource
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
