import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
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
})
