import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  canConfirmOpenCodeAccountDelete,
  isOpenCodeAccountDeleteDialogOpen,
  isOpenCodeAccountPageRefreshing,
  openCodeAccountWorkspaceGridRows,
  refreshOpenCodeAccountPageData,
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
})
