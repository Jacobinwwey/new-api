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

type OpenCodeScreenshotPointer = {
  clientX: number
  clientY: number
}

type OpenCodeScreenshotElementRect = {
  left: number
  top: number
  width: number
  height: number
}

type OpenCodeRemoteViewport = {
  width: number
  height: number
}

export const OPEN_CODE_INTERACTION_SCREENSHOT_REFRESH_DELAY_MS = 350

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

export function canRefreshOpenCodeLoginScreenshot(
  accountID: number,
  selectedAccountID: number | null,
  isScreenshotPending: boolean
) {
  return selectedAccountID === accountID && !isScreenshotPending
}

export function canUseOpenCodeLoginScreenshotResponse(
  accountID: number,
  selectedAccountID: number | null
) {
  return selectedAccountID === accountID
}

export function shouldClearOpenCodeLoginScreenshotOnAccountSelect(
  currentAccountID: number | null,
  nextAccountID: number
) {
  return currentAccountID !== nextAccountID
}

export function mapContainedScreenshotClickToRemotePoint(
  pointer: OpenCodeScreenshotPointer,
  elementRect: OpenCodeScreenshotElementRect,
  viewport: OpenCodeRemoteViewport
) {
  if (
    elementRect.width <= 0 ||
    elementRect.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null
  }

  const viewportAspectRatio = viewport.width / viewport.height
  const elementAspectRatio = elementRect.width / elementRect.height
  const contentWidth =
    elementAspectRatio > viewportAspectRatio
      ? elementRect.height * viewportAspectRatio
      : elementRect.width
  const contentHeight =
    elementAspectRatio > viewportAspectRatio
      ? elementRect.height
      : elementRect.width / viewportAspectRatio
  const contentLeft = elementRect.left + (elementRect.width - contentWidth) / 2
  const contentTop = elementRect.top + (elementRect.height - contentHeight) / 2
  const normalizedX = (pointer.clientX - contentLeft) / contentWidth
  const normalizedY = (pointer.clientY - contentTop) / contentHeight

  if (
    normalizedX < 0 ||
    normalizedX > 1 ||
    normalizedY < 0 ||
    normalizedY > 1
  ) {
    return null
  }

  return {
    x: clampRemoteCoordinate(
      Math.round(normalizedX * viewport.width),
      viewport.width
    ),
    y: clampRemoteCoordinate(
      Math.round(normalizedY * viewport.height),
      viewport.height
    ),
  }
}

function clampRemoteCoordinate(coordinate: number, remoteExtent: number) {
  return Math.min(Math.max(coordinate, 0), remoteExtent - 1)
}
