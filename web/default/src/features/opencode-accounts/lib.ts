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

type OpenCodePopupScreen =
  | {
      availWidth?: number
      availHeight?: number
    }
  | null
  | undefined

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

type OpenCodeLoginScreenshotPayload =
  | {
      image_base64?: string
      width?: number
      height?: number
      hotspots?: unknown
    }
  | null
  | undefined

export type OpenCodeLoginScreenshotImage = {
  imageBase64: string
  width: number
  height: number
  hotspots: OpenCodeLoginHotspot[]
}

export type OpenCodeLoginHotspot = {
  id: string
  label: string
  provider?: string
  x: number
  y: number
  width: number
  height: number
}

type OpenCodeLoginStatusLabelSource = {
  title?: string
  url?: string
  accountLabel?: string
  fallback: string
}

type OpenCodeLoginScreenshotStatusSource = {
  running?: boolean
  status?: string
}

export const OPEN_CODE_INTERACTION_SCREENSHOT_REFRESH_DELAYS_MS = [
  350, 1250, 2500, 5000,
] as const
export const OPEN_CODE_ACCOUNT_STATE_REFRESH_INTERVAL_MS = 5000
export const OPEN_CODE_REMOTE_BROWSER_PATH = '/opencode-browser'

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

export function openCodeRemoteBrowserWindowURL(accountID: number) {
  if (!Number.isInteger(accountID) || accountID <= 0) {
    return ''
  }
  const search = new URLSearchParams({ account_id: String(accountID) })
  return `${OPEN_CODE_REMOTE_BROWSER_PATH}?${search.toString()}`
}

export function openCodeRemoteBrowserPopupFeatures(
  screenSize: OpenCodePopupScreen = typeof window === 'undefined'
    ? null
    : window.screen
) {
  const availWidth = Math.max(0, Number(screenSize?.availWidth) || 0)
  const availHeight = Math.max(0, Number(screenSize?.availHeight) || 0)
  const width = popupAxisExtent(availWidth, 1440, 900)
  const height = popupAxisExtent(availHeight, 1000, 700)
  const left = Math.max(0, Math.round((availWidth - width) / 2))
  const top = Math.max(0, Math.round((availHeight - height) / 2))

  return [
    'popup=yes',
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
    'resizable=yes',
    'scrollbars=no',
  ].join(',')
}

export function normalizeOpenCodeLoginScreenshot(
  screenshot: OpenCodeLoginScreenshotPayload
): OpenCodeLoginScreenshotImage | null {
  const imageBase64 = screenshot?.image_base64
  const width = screenshot?.width
  const height = screenshot?.height

  if (
    typeof imageBase64 !== 'string' ||
    imageBase64.length === 0 ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }

  return {
    imageBase64,
    width,
    height,
    hotspots: normalizeOpenCodeLoginHotspots(screenshot?.hotspots),
  }
}

function normalizeOpenCodeLoginHotspots(
  hotspots: unknown
): OpenCodeLoginHotspot[] {
  if (!Array.isArray(hotspots)) {
    return []
  }

  return hotspots
    .map((hotspot): OpenCodeLoginHotspot | null => {
      const candidate = hotspot as Partial<OpenCodeLoginHotspot> | null
      if (
        !candidate ||
        typeof candidate.id !== 'string' ||
        typeof candidate.label !== 'string' ||
        typeof candidate.x !== 'number' ||
        typeof candidate.y !== 'number' ||
        typeof candidate.width !== 'number' ||
        typeof candidate.height !== 'number' ||
        !Number.isFinite(candidate.x) ||
        !Number.isFinite(candidate.y) ||
        !Number.isFinite(candidate.width) ||
        !Number.isFinite(candidate.height) ||
        candidate.width <= 0 ||
        candidate.height <= 0
      ) {
        return null
      }

      return {
        id: candidate.id,
        label: candidate.label,
        provider:
          typeof candidate.provider === 'string'
            ? candidate.provider
            : undefined,
        x: Math.round(candidate.x),
        y: Math.round(candidate.y),
        width: Math.round(candidate.width),
        height: Math.round(candidate.height),
      }
    })
    .filter((hotspot): hotspot is OpenCodeLoginHotspot => hotspot !== null)
}

export function shouldClearOpenCodeLoginScreenshotForStatus(
  status: OpenCodeLoginScreenshotStatusSource | null | undefined
) {
  return status?.running === false || status?.status === 'stopped'
}

export function shouldClearOpenCodeLoginScreenshotOnAccountSelect(
  currentAccountID: number | null,
  nextAccountID: number
) {
  return currentAccountID !== nextAccountID
}

export function openCodeLoginStatusLabel(
  source: OpenCodeLoginStatusLabelSource
) {
  return (
    source.title?.trim() ||
    source.url?.trim() ||
    source.accountLabel?.trim() ||
    source.fallback
  )
}

export function mapContainedScreenshotClickToRemotePoint(
  pointer: OpenCodeScreenshotPointer,
  elementRect: OpenCodeScreenshotElementRect,
  viewport: OpenCodeRemoteViewport
) {
  const contentRect = containedScreenshotRect(elementRect, viewport)
  if (contentRect === null) {
    return null
  }
  const {
    left: contentLeft,
    top: contentTop,
    width: contentWidth,
    height: contentHeight,
  } = contentRect
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

export function mapRemoteHotspotToContainedScreenshotRect(
  hotspot: OpenCodeLoginHotspot,
  elementRect: OpenCodeScreenshotElementRect,
  viewport: OpenCodeRemoteViewport
) {
  const contentRect = containedScreenshotRect(elementRect, viewport)
  if (contentRect === null) {
    return null
  }

  return {
    left: contentRect.left + (hotspot.x / viewport.width) * contentRect.width,
    top: contentRect.top + (hotspot.y / viewport.height) * contentRect.height,
    width: (hotspot.width / viewport.width) * contentRect.width,
    height: (hotspot.height / viewport.height) * contentRect.height,
  }
}

function containedScreenshotRect(
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
  const width =
    elementAspectRatio > viewportAspectRatio
      ? elementRect.height * viewportAspectRatio
      : elementRect.width
  const height =
    elementAspectRatio > viewportAspectRatio
      ? elementRect.height
      : elementRect.width / viewportAspectRatio

  return {
    left: elementRect.left + (elementRect.width - width) / 2,
    top: elementRect.top + (elementRect.height - height) / 2,
    width,
    height,
  }
}

function clampRemoteCoordinate(coordinate: number, remoteExtent: number) {
  return Math.min(Math.max(coordinate, 0), remoteExtent - 1)
}

function popupAxisExtent(
  available: number,
  maximum: number,
  insetThreshold: number
) {
  if (available <= 0) return maximum
  if (available < insetThreshold) return available
  return Math.min(maximum, Math.round(available * 0.9))
}
