import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Download,
  MousePointerClick,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react'
import { type MouseEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

import {
  activateOpenCodeAccount,
  clickOpenCodeLogin,
  createOpenCodeAccount,
  deleteOpenCodeAccount,
  extractOpenCodeLogin,
  getOpenCodeLoginScreenshot,
  getOpenCodeLoginStatus,
  keyOpenCodeLogin,
  listOpenCodeAccounts,
  refreshOpenCodeQuota,
  startOpenCodeLogin,
  stopOpenCodeLogin,
} from './api'
import type { OpenCodeAccount } from './types'

const VIEWPORT_WIDTH = 1280
const VIEWPORT_HEIGHT = 900

export function OpenCodeAccounts() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedID, setSelectedID] = useState<number | null>(null)
  const [label, setLabel] = useState('')
  const [channelID, setChannelID] = useState('')
  const [textInput, setTextInput] = useState('')
  const [screenshot, setScreenshot] = useState('')

  const accountsQuery = useQuery({
    queryKey: ['opencode-accounts'],
    queryFn: listOpenCodeAccounts,
  })
  const accounts = accountsQuery.data?.data ?? []
  const selectedAccount =
    accounts.find((account) => account.id === selectedID) ?? null
  const selectedAccountID = selectedAccount?.id ?? null

  const statusQuery = useQuery({
    queryKey: ['opencode-login-status', selectedAccountID],
    queryFn: () => getOpenCodeLoginStatus(selectedAccountID as number),
    enabled: selectedAccountID !== null,
    refetchInterval: 5000,
    retry: false,
  })
  const loginStatus = statusQuery.data?.data

  const refreshAccounts = () =>
    queryClient.invalidateQueries({ queryKey: ['opencode-accounts'] })

  const createMutation = useMutation({
    mutationFn: createOpenCodeAccount,
    onSuccess: async (response) => {
      await refreshAccounts()
      setSelectedID(response.data.id)
      setLabel('')
      setChannelID('')
      toast.success(t('OpenCode account created'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteOpenCodeAccount,
    onSuccess: async () => {
      await refreshAccounts()
      setSelectedID(null)
      setScreenshot('')
      toast.success(t('OpenCode account deleted'))
    },
  })

  const startMutation = useMutation({
    mutationFn: startOpenCodeLogin,
    onSuccess: async () => {
      await statusQuery.refetch()
      toast.success(t('OpenCode login session started'))
    },
  })

  const screenshotMutation = useMutation({
    mutationFn: getOpenCodeLoginScreenshot,
    onSuccess: (response) => {
      setScreenshot(response.data.image_base64)
    },
  })

  const clickMutation = useMutation({
    mutationFn: (point: { id: number; x: number; y: number }) =>
      clickOpenCodeLogin(point.id, { x: point.x, y: point.y }),
    onSuccess: async () => {
      await statusQuery.refetch()
    },
  })

  const keyMutation = useMutation({
    mutationFn: (request: { id: number; text: string }) =>
      keyOpenCodeLogin(request.id, { text: request.text }),
    onSuccess: async () => {
      setTextInput('')
      await statusQuery.refetch()
    },
  })

  const extractMutation = useMutation({
    mutationFn: extractOpenCodeLogin,
    onSuccess: async () => {
      await refreshAccounts()
      toast.success(t('OpenCode account material extracted'))
    },
  })

  const quotaMutation = useMutation({
    mutationFn: refreshOpenCodeQuota,
    onSuccess: async () => {
      await refreshAccounts()
      toast.success(t('OpenCode quota refreshed'))
    },
  })

  const activateMutation = useMutation({
    mutationFn: activateOpenCodeAccount,
    onSuccess: async () => {
      await refreshAccounts()
      toast.success(t('OpenCode account activated'))
    },
  })

  const stopMutation = useMutation({
    mutationFn: stopOpenCodeLogin,
    onSuccess: async () => {
      await statusQuery.refetch()
      toast.success(t('OpenCode login session stopped'))
    },
  })

  const handleCreate = () => {
    const parsedChannelID = Number(channelID)
    if (!label.trim() || !Number.isInteger(parsedChannelID)) {
      toast.error(t('Label and channel ID are required'))
      return
    }
    createMutation.mutate({
      label,
      channel_id: parsedChannelID,
    })
  }

  const runSelected = (action: (id: number) => void) => {
    if (selectedAccountID === null) {
      toast.error(t('Select an OpenCode account first'))
      return
    }
    action(selectedAccountID)
  }

  const handleScreenshotClick = (event: MouseEvent<HTMLImageElement>) => {
    if (selectedAccountID === null) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.round(
      ((event.clientX - rect.left) / rect.width) * VIEWPORT_WIDTH
    )
    const y = Math.round(
      ((event.clientY - rect.top) / rect.height) * VIEWPORT_HEIGHT
    )
    clickMutation.mutate({ id: selectedAccountID, x, y })
  }

  return (
    <SectionPageLayout fixedContent>
      <SectionPageLayout.Title>
        {t('OpenCode Accounts')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          onClick={() => accountsQuery.refetch()}
          disabled={accountsQuery.isFetching}
        >
          <RefreshCw data-icon='inline-start' />
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(480px,0.9fr)]'>
          <section className='min-w-0 rounded-lg border bg-background'>
            <div className='grid gap-3 border-b p-3 md:grid-cols-[minmax(0,1fr)_160px_auto]'>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('Account label')}
              />
              <Input
                value={channelID}
                onChange={(event) => setChannelID(event.target.value)}
                placeholder={t('Channel ID')}
                inputMode='numeric'
              />
              <Button
                onClick={handleCreate}
                disabled={createMutation.isPending}
              >
                <Check data-icon='inline-start' />
                {t('Create')}
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Label')}</TableHead>
                  <TableHead>{t('Channel')}</TableHead>
                  <TableHead>{t('Secrets')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead className='w-16 text-right'>
                    {t('Actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    selected={account.id === selectedID}
                    onSelect={() => setSelectedID(account.id)}
                    onDelete={() => deleteMutation.mutate(account.id)}
                  />
                ))}
                {accounts.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className='text-muted-foreground h-24 text-center'
                    >
                      {t('No OpenCode accounts')}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </section>

          <section className='grid min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 rounded-lg border bg-background p-3'>
            <div className='flex min-w-0 flex-wrap items-center gap-2'>
              <Badge variant={loginStatus?.running ? 'default' : 'outline'}>
                {loginStatus?.running ? t('Running') : t('Stopped')}
              </Badge>
              <span className='text-muted-foreground min-w-0 truncate text-sm'>
                {loginStatus?.url || selectedAccount?.label || t('No account selected')}
              </span>
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                variant='outline'
                onClick={() => runSelected((id) => startMutation.mutate(id))}
                disabled={startMutation.isPending}
              >
                <Play data-icon='inline-start' />
                {t('Login')}
              </Button>
              <Button
                variant='outline'
                onClick={() =>
                  runSelected((id) => screenshotMutation.mutate(id))
                }
                disabled={screenshotMutation.isPending}
              >
                <MousePointerClick data-icon='inline-start' />
                {t('Screenshot')}
              </Button>
              <Button
                variant='outline'
                onClick={() => runSelected((id) => extractMutation.mutate(id))}
                disabled={extractMutation.isPending}
              >
                <Download data-icon='inline-start' />
                {t('Extract')}
              </Button>
              <Button
                variant='outline'
                onClick={() => runSelected((id) => quotaMutation.mutate(id))}
                disabled={quotaMutation.isPending}
              >
                <RefreshCw data-icon='inline-start' />
                {t('Quota')}
              </Button>
              <Button
                variant='outline'
                onClick={() => runSelected((id) => activateMutation.mutate(id))}
                disabled={activateMutation.isPending}
              >
                <Check data-icon='inline-start' />
                {t('Activate')}
              </Button>
              <Button
                variant='outline'
                onClick={() => runSelected((id) => stopMutation.mutate(id))}
                disabled={stopMutation.isPending}
              >
                <Square data-icon='inline-start' />
                {t('Stop')}
              </Button>
            </div>
            <div className='grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3'>
              <div className='bg-muted/30 flex min-h-[280px] items-center justify-center overflow-hidden rounded-md border'>
                {screenshot ? (
                  <img
                    src={`data:image/png;base64,${screenshot}`}
                    alt={t('Remote browser')}
                    className='h-full max-h-full w-full max-w-full cursor-crosshair object-contain'
                    onClick={handleScreenshotClick}
                  />
                ) : (
                  <span className='text-muted-foreground text-sm'>
                    {t('Start login and capture a screenshot')}
                  </span>
                )}
              </div>
              <div className='grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]'>
                <Input
                  value={textInput}
                  onChange={(event) => setTextInput(event.target.value)}
                  placeholder={t('Text to type into remote browser')}
                />
                <Button
                  variant='outline'
                  onClick={() =>
                    runSelected((id) =>
                      keyMutation.mutate({ id, text: textInput })
                    )
                  }
                  disabled={!textInput || keyMutation.isPending}
                >
                  {t('Type Text')}
                </Button>
              </div>
            </div>
          </section>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

type AccountRowProps = {
  account: OpenCodeAccount
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}

function AccountRow(props: AccountRowProps) {
  const { t } = useTranslation()
  const secretCount = [
    props.account.has_api_key,
    props.account.has_cookie,
    props.account.has_workspace_id,
  ].filter(Boolean).length

  return (
    <TableRow
      data-state={props.selected ? 'selected' : undefined}
      className={cn('cursor-pointer', props.selected && 'bg-muted/60')}
      onClick={props.onSelect}
    >
      <TableCell>
        <div className='grid min-w-0 gap-1'>
          <span className='truncate font-medium'>{props.account.label}</span>
          <span className='text-muted-foreground truncate text-xs'>
            {props.account.email_masked || t('No email')}
          </span>
        </div>
      </TableCell>
      <TableCell>#{props.account.channel_id}</TableCell>
      <TableCell>
        <Badge variant={secretCount >= 3 ? 'default' : 'outline'}>
          {secretCount}/3
        </Badge>
      </TableCell>
      <TableCell>
        <div className='flex flex-wrap items-center gap-2'>
          <Badge variant={props.account.active ? 'default' : 'outline'}>
            {props.account.active ? t('Active') : t('Ready')}
          </Badge>
          {props.account.quota_limit > 0 ? (
            <span className='text-muted-foreground text-xs'>
              {props.account.quota_used}/{props.account.quota_limit}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className='text-right'>
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label={t('Delete')}
          onClick={(event) => {
            event.stopPropagation()
            props.onDelete()
          }}
        >
          <Trash2 />
        </Button>
      </TableCell>
    </TableRow>
  )
}
