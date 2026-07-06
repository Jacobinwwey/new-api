import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildCacheStatsRows } from './cache-stats-dialog.lib'

const t = (key: string) => key
const formatTimestamp = (timestamp: number | undefined) =>
  `formatted:${timestamp ?? 0}`

describe('channel affinity cache stats rows', () => {
  test('builds a concise row set from cache usage stats', () => {
    const rows = buildCacheStatsRows(
      {
        hit: 3,
        total: 4,
        prompt_tokens: 1000,
        cached_tokens: 700,
        completion_tokens: 20,
        total_tokens: 1020,
        window_seconds: 600,
        last_seen_at: 1720000000,
      },
      {
        rule_name: 'codex cli trace',
        using_group: 'default',
        key_hint: 'glm prompt',
        key_fp: 'abc123',
      },
      { t, formatTimestamp }
    )

    assert.deepEqual(rows, [
      { key: 'Rule', value: 'codex cli trace' },
      { key: 'Group', value: 'default' },
      { key: 'Key Summary', value: 'glm prompt' },
      { key: 'Key Fingerprint', value: 'abc123' },
      { key: 'TTL (seconds)', value: 600 },
      { key: 'Hit Rate', value: '3/4 (75.00%)' },
      { key: 'Last Seen', value: 'formatted:1720000000' },
      { key: 'Prompt tokens', value: 1000 },
      { key: 'Cached tokens', value: 700 },
      { key: 'Completion tokens', value: 20 },
      { key: 'Total tokens', value: 1020 },
    ])
  })

  test('returns no rows without stats', () => {
    assert.deepEqual(
      buildCacheStatsRows(null, null, { t, formatTimestamp }),
      []
    )
  })
})
