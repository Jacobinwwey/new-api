export type CacheStatsDialogTarget = {
  rule_name: string
  using_group: string
  key_hint: string
  key_fp: string
}

type CacheStatsRowsContext = {
  t: (key: string) => string
  formatTimestamp: (timestamp: number | undefined) => string
}

export type CacheStatsRow = {
  key: string
  value: string | number
}

function formatRate(hit: number, total: number): string {
  if (!total || total <= 0) {
    return '-'
  }

  const rate = (hit / total) * 100
  if (!Number.isFinite(rate)) {
    return '-'
  }

  return `${rate.toFixed(2)}%`
}

export function buildCacheStatsRows(
  stats: Record<string, unknown> | null,
  target: CacheStatsDialogTarget | null,
  context: CacheStatsRowsContext
): CacheStatsRow[] {
  if (!stats) {
    return []
  }

  const rows: CacheStatsRow[] = []
  const hit = Number(stats.hit || 0)
  const total = Number(stats.total || 0)

  if (stats.rule_name || target?.rule_name) {
    rows.push({
      key: context.t('Rule'),
      value: (stats.rule_name || target?.rule_name || '') as string,
    })
  }

  if (stats.using_group || target?.using_group) {
    rows.push({
      key: context.t('Group'),
      value: (stats.using_group || target?.using_group || '') as string,
    })
  }

  if (target?.key_hint) {
    rows.push({ key: context.t('Key Summary'), value: target.key_hint })
  }

  if (stats.key_fp || target?.key_fp) {
    rows.push({
      key: context.t('Key Fingerprint'),
      value: (stats.key_fp || target?.key_fp || '') as string,
    })
  }

  if (Number(stats.window_seconds || 0) > 0) {
    rows.push({
      key: context.t('TTL (seconds)'),
      value: stats.window_seconds as number,
    })
  }

  if (total > 0) {
    rows.push({
      key: context.t('Hit Rate'),
      value: `${hit}/${total} (${formatRate(hit, total)})`,
    })
  }

  if (Number(stats.last_seen_at || 0) > 0) {
    rows.push({
      key: context.t('Last Seen'),
      value: context.formatTimestamp(stats.last_seen_at as number | undefined),
    })
  }

  const promptTokens = Number(stats.prompt_tokens || 0)
  const cachedTokens = Number(stats.cached_tokens || 0)
  const completionTokens = Number(stats.completion_tokens || 0)
  const totalTokens = Number(stats.total_tokens || 0)

  if (promptTokens > 0) {
    rows.push({ key: context.t('Prompt tokens'), value: promptTokens })
  }

  if (cachedTokens > 0) {
    rows.push({ key: context.t('Cached tokens'), value: cachedTokens })
  }

  if (completionTokens > 0) {
    rows.push({ key: context.t('Completion tokens'), value: completionTokens })
  }

  if (totalTokens > 0) {
    rows.push({ key: context.t('Total tokens'), value: totalTokens })
  }

  return rows
}
