import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  canConfirmOpenCodeAccountDelete,
  isOpenCodeAccountDeleteDialogOpen,
  isOpenCodeAccountPageRefreshing,
  mapContainedScreenshotClickToRemotePoint,
  openCodeAccountWorkspaceGridRows,
  refreshOpenCodeAccountPageData,
  requireSuccessfulOpenCodeResponse,
} from './lib'

function createRefreshSource() {
  let refreshCount = 0

  return {
    source: {
      isFetching: false,
      refetch() {
        refreshCount += 1
      },
    },
    get refreshCount() {
      return refreshCount
    },
  }
}

describe('OpenCode account page helpers', () => {
  test('keeps successful API responses on the success path', () => {
    const response = {
      success: true,
      data: { id: 7 },
    }

    assert.equal(
      requireSuccessfulOpenCodeResponse(response, 'request failed'),
      response
    )
  })

  test('throws business API failures before callers run success handlers', () => {
    assert.throws(
      () =>
        requireSuccessfulOpenCodeResponse(
          { success: false, message: 'purge failed' },
          'request failed'
        ),
      /purge failed/
    )
    assert.throws(
      () =>
        requireSuccessfulOpenCodeResponse({ success: false }, 'request failed'),
      /request failed/
    )
    assert.throws(
      () => requireSuccessfulOpenCodeResponse(null, 'request failed'),
      /request failed/
    )
  })

  test('refreshes accounts, channels, and diagnostics together', () => {
    const accounts = createRefreshSource()
    const channels = createRefreshSource()
    const diagnostics = createRefreshSource()

    refreshOpenCodeAccountPageData({
      accounts: accounts.source,
      channels: channels.source,
      diagnostics: diagnostics.source,
    })

    assert.equal(accounts.refreshCount, 1)
    assert.equal(channels.refreshCount, 1)
    assert.equal(diagnostics.refreshCount, 1)
  })

  test('disables refresh while any page source is fetching', () => {
    const idleSource = { isFetching: false, refetch() {} }
    const fetchingSource = { isFetching: true, refetch() {} }

    assert.equal(
      isOpenCodeAccountPageRefreshing({
        accounts: idleSource,
        channels: idleSource,
        diagnostics: idleSource,
      }),
      false
    )
    assert.equal(
      isOpenCodeAccountPageRefreshing({
        accounts: idleSource,
        channels: fetchingSource,
        diagnostics: idleSource,
      }),
      true
    )
  })

  test('keeps the workspace in a bounded fixed-content row when warning is visible', () => {
    assert.equal(
      openCodeAccountWorkspaceGridRows(false),
      'grid-rows-[minmax(0,1fr)]'
    )
    assert.equal(
      openCodeAccountWorkspaceGridRows(true),
      'grid-rows-[auto_minmax(0,1fr)]'
    )
  })

  test('opens delete confirmation only when an account is targeted', () => {
    assert.equal(isOpenCodeAccountDeleteDialogOpen(null), false)
    assert.equal(
      isOpenCodeAccountDeleteDialogOpen({
        id: 7,
        label: 'production opencode',
      }),
      true
    )
  })

  test('allows delete confirmation only while a target exists and delete is idle', () => {
    const target = {
      id: 7,
      label: 'production opencode',
    }

    assert.equal(canConfirmOpenCodeAccountDelete(null, false), false)
    assert.equal(canConfirmOpenCodeAccountDelete(target, true), false)
    assert.equal(canConfirmOpenCodeAccountDelete(target, false), true)
  })

  test('maps contained screenshot clicks without letterbox offset', () => {
    assert.deepEqual(
      mapContainedScreenshotClickToRemotePoint(
        { clientX: 640, clientY: 450 },
        { left: 0, top: 0, width: 1280, height: 900 },
        { width: 1280, height: 900 }
      ),
      { x: 640, y: 450 }
    )
  })

  test('maps contained screenshot clicks inside horizontal letterbox content only', () => {
    assert.equal(
      mapContainedScreenshotClickToRemotePoint(
        { clientX: 100, clientY: 450 },
        { left: 0, top: 0, width: 1600, height: 900 },
        { width: 1280, height: 900 }
      ),
      null
    )
    assert.deepEqual(
      mapContainedScreenshotClickToRemotePoint(
        { clientX: 800, clientY: 450 },
        { left: 0, top: 0, width: 1600, height: 900 },
        { width: 1280, height: 900 }
      ),
      { x: 640, y: 450 }
    )
    assert.deepEqual(
      mapContainedScreenshotClickToRemotePoint(
        { clientX: 1440, clientY: 900 },
        { left: 0, top: 0, width: 1600, height: 900 },
        { width: 1280, height: 900 }
      ),
      { x: 1279, y: 899 }
    )
  })

  test('maps contained screenshot clicks inside vertical letterbox content only', () => {
    assert.equal(
      mapContainedScreenshotClickToRemotePoint(
        { clientX: 640, clientY: 100 },
        { left: 0, top: 0, width: 1280, height: 1200 },
        { width: 1280, height: 900 }
      ),
      null
    )
    assert.deepEqual(
      mapContainedScreenshotClickToRemotePoint(
        { clientX: 640, clientY: 600 },
        { left: 0, top: 0, width: 1280, height: 1200 },
        { width: 1280, height: 900 }
      ),
      { x: 640, y: 450 }
    )
  })

  test('ignores screenshot clicks when geometry is invalid', () => {
    assert.equal(
      mapContainedScreenshotClickToRemotePoint(
        { clientX: 1, clientY: 1 },
        { left: 0, top: 0, width: 0, height: 900 },
        { width: 1280, height: 900 }
      ),
      null
    )
    assert.equal(
      mapContainedScreenshotClickToRemotePoint(
        { clientX: 1, clientY: 1 },
        { left: 0, top: 0, width: 1280, height: 900 },
        { width: 0, height: 900 }
      ),
      null
    )
  })
})
