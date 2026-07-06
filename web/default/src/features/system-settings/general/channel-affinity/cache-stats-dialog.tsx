/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useEffect, useMemo, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { formatTimestampToDate } from '@/lib/format'

import { getAffinityUsageCache } from './api'
import {
  buildCacheStatsRows,
  type CacheStatsDialogTarget,
} from './cache-stats-dialog.lib'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: CacheStatsDialogTarget | null
}

export function CacheStatsDialog(props: Props) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    if (!props.open || !props.target?.rule_name || !props.target?.key_fp) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStats(null)
      return
    }

    const target = props.target
    const seq = ++seqRef.current

    setLoading(true)

    setStats(null)

    async function loadStats() {
      try {
        const res = await getAffinityUsageCache(target)
        if (seq !== seqRef.current) {
          return
        }

        if (res.success) {
          setStats((res.data as Record<string, unknown>) || {})
          return
        }

        toast.error(res.message || t('Request failed'))
      } catch {
        if (seq !== seqRef.current) {
          return
        }

        toast.error(t('Request failed'))
      } finally {
        if (seq === seqRef.current) {
          setLoading(false)
        }
      }
    }

    void loadStats()
  }, [props.open, props.target, t])

  const rows = useMemo(() => {
    return buildCacheStatsRows(stats, props.target, {
      t,
      formatTimestamp: formatTimestampToDate,
    })
  }, [stats, props.target, t])

  let content = (
    <div className='text-muted-foreground py-8 text-center text-sm'>
      {t('No data available')}
    </div>
  )

  if (loading) {
    content = (
      <div className='text-muted-foreground py-8 text-center text-sm'>
        {t('Loading...')}
      </div>
    )
  } else if (rows.length > 0) {
    content = (
      <div className='space-y-2'>
        {rows.map((row) => (
          <div
            key={row.key}
            className='flex justify-between gap-4 border-b pb-1 text-sm'
          >
            <span className='text-muted-foreground'>{row.key}</span>
            <span className='text-right font-medium break-all'>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Channel Affinity: Upstream Cache Hit')}
      contentClassName='sm:max-w-lg'
      contentHeight='auto'
      bodyClassName='space-y-4'
    >
      <p className='text-muted-foreground text-xs'>
        {t(
          'Hit criteria: If cached tokens exist in usage, it counts as a hit.'
        )}
      </p>
      {content}
    </Dialog>
  )
}
