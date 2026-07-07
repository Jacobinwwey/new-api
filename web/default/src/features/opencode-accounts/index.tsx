import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  Check,
  CornerDownLeftIcon,
  DeleteIcon,
  Download,
  IndentIncreaseIcon,
  type LucideIcon,
  MousePointerClick,
  Play,
  RefreshCw,
  Square,
  Trash2,
  XIcon,
} from 'lucide-react'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { getChannels } from '@/features/channels/api'
import { getChannelTypeLabel } from '@/features/channels/lib'
import type { Channel } from '@/features/channels/types'
import { cn } from '@/lib/utils'

import {
  activateOpenCodeAccount,
  clickOpenCodeLogin,
  createOpenCodeAccount,
  deleteOpenCodeAccount,
  extractOpenCodeLogin,
  getOpenCodeAccountDiagnostics,
  getOpenCodeLoginScreenshot,
  getOpenCodeLoginStatus,
  keyOpenCodeLogin,
  listOpenCodeAccounts,
  pressOpenCodeLogin,
  refreshOpenCodeQuota,
  startOpenCodeLogin,
  stopOpenCodeLogin,
} from './api'
import {
  OPEN_CODE_INTERACTION_SCREENSHOT_REFRESH_DELAY_MS,
  canConfirmOpenCodeAccountDelete,
  canRefreshOpenCodeLoginScreenshot,
  canUseOpenCodeLoginScreenshotResponse,
  isOpenCodeAccountDeleteDialogOpen,
  isOpenCodeAccountPageRefreshing,
  mapContainedScreenshotClickToRemotePoint,
  openCodeAccountWorkspaceGridRows,
  refreshOpenCodeAccountPageData,
  shouldClearOpenCodeLoginScreenshotOnAccountSelect,
  type OpenCodeAccountDeleteTarget,
} from './lib'
import type { OpenCodeAccount, OpenCodePressKey } from './types'

const VIEWPORT_WIDTH = 1280
const VIEWPORT_HEIGHT = 900
const OPEN_CODE_PRESS_KEY_CONTROLS: {
  key: OpenCodePressKey
  label: string
  Icon: LucideIcon
}[] = [
  { key: 'Enter', label: 'Enter', Icon: CornerDownLeftIcon },
  { key: 'Tab', label: 'Tab', Icon: IndentIncreaseIcon },
  { key: 'Backspace', label: 'Backspace', Icon: DeleteIcon },
  { key: 'Escape', label: 'Escape', Icon: XIcon },
  { key: 'ArrowUp', label: 'Arrow up', Icon: ArrowUpIcon },
  { key: 'ArrowDown', label: 'Arrow down', Icon: ArrowDownIcon },
  { key: 'ArrowLeft', label: 'Arrow left', Icon: ArrowLeftIcon },
  { key: 'ArrowRight', label: 'Arrow right', Icon: ArrowRightIcon },
]

export function OpenCodeAccounts() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedID, setSelectedID] = useState<number | null>(null)
  const [label, setLabel] = useState('')
  const [channelID, setChannelID] = useState('')
  const [textInput, setTextInput] = useState('')
  const [screenshot, setScreenshot] = useState('')
  const [deleteTarget, setDeleteTarget] =
    useState<OpenCodeAccountDeleteTarget>(null)
  const selectedAccountIDRef = useRef<number | null>(null)
  const screenshotPendingRef = useRef(false)
  const screenshotRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null)

  const accountsQuery = useQuery({
    queryKey: ['opencode-accounts'],
    queryFn: listOpenCodeAccounts,
  })
  const channelsQuery = useQuery({
    queryKey: ['opencode-channel-options'],
    queryFn: () =>
      getChannels({
        p: 1,
        page_size: 200,
        status: 'enabled',
        id_sort: true,
      }),
    retry: false,
  })
  const diagnosticsQuery = useQuery({
    queryKey: ['opencode-account-diagnostics'],
    queryFn: getOpenCodeAccountDiagnostics,
    retry: false,
  })
  const accounts = accountsQuery.data?.data ?? []
  const channels = channelsQuery.data?.data?.items ?? []
  const usesFallbackCredentialKey =
    diagnosticsQuery.data?.data.uses_fallback_credential_key === true
  const selectedAccount =
    accounts.find((account) => account.id === selectedID) ?? null
  const selectedAccountID = selectedAccount?.id ?? null
  selectedAccountIDRef.current = selectedAccountID

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

  const refreshSources = {
    accounts: accountsQuery,
    channels: channelsQuery,
    diagnostics: diagnosticsQuery,
  }

  const createMutation = useMutation({
    mutationFn: createOpenCodeAccount,
    onSuccess: async (response) => {
      await refreshAccounts()
      if (
        shouldClearOpenCodeLoginScreenshotOnAccountSelect(
          selectedID,
          response.data.id
        )
      ) {
        setScreenshot('')
      }
      setSelectedID(response.data.id)
      setLabel('')
      setChannelID('')
      toast.success(t('OpenCode account created'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteOpenCodeAccount,
    onSuccess: async (_response, deletedID) => {
      await refreshAccounts()
      if (selectedID === deletedID) {
        setSelectedID(null)
        setScreenshot('')
      }
      setDeleteTarget(null)
      toast.success(t('OpenCode account deleted'))
    },
  })

  const screenshotMutation = useMutation({
    mutationFn: getOpenCodeLoginScreenshot,
    onSuccess: (response, accountID) => {
      if (
        !canUseOpenCodeLoginScreenshotResponse(
          accountID,
          selectedAccountIDRef.current
        )
      ) {
        return
      }
      setScreenshot(response.data.image_base64)
    },
  })
  screenshotPendingRef.current = screenshotMutation.isPending

  const scheduleScreenshotRefreshAfterInteraction = (accountID: number) => {
    if (
      !canRefreshOpenCodeLoginScreenshot(
        accountID,
        selectedAccountIDRef.current,
        screenshotPendingRef.current
      )
    ) {
      return
    }
    if (screenshotRefreshTimerRef.current !== null) {
      clearTimeout(screenshotRefreshTimerRef.current)
    }
    screenshotRefreshTimerRef.current = setTimeout(() => {
      screenshotRefreshTimerRef.current = null
      if (
        !canRefreshOpenCodeLoginScreenshot(
          accountID,
          selectedAccountIDRef.current,
          screenshotPendingRef.current
        )
      ) {
        return
      }
      screenshotMutation.mutate(accountID)
    }, OPEN_CODE_INTERACTION_SCREENSHOT_REFRESH_DELAY_MS)
  }

  useEffect(
    () => () => {
      if (screenshotRefreshTimerRef.current !== null) {
        clearTimeout(screenshotRefreshTimerRef.current)
      }
    },
    []
  )

  const startMutation = useMutation({
    mutationFn: startOpenCodeLogin,
    onSuccess: async (_response, accountID) => {
      await statusQuery.refetch()
      scheduleScreenshotRefreshAfterInteraction(accountID)
      toast.success(t('OpenCode login session started'))
    },
  })

  const clickMutation = useMutation({
    mutationFn: (point: { id: number; x: number; y: number }) =>
      clickOpenCodeLogin(point.id, { x: point.x, y: point.y }),
    onSuccess: async (_response, point) => {
      await statusQuery.refetch()
      scheduleScreenshotRefreshAfterInteraction(point.id)
    },
  })

  const keyMutation = useMutation({
    mutationFn: (request: { id: number; text: string }) =>
      keyOpenCodeLogin(request.id, { text: request.text }),
    onSuccess: async (_response, request) => {
      setTextInput('')
      await statusQuery.refetch()
      scheduleScreenshotRefreshAfterInteraction(request.id)
    },
  })

  const pressMutation = useMutation({
    mutationFn: (request: { id: number; key: OpenCodePressKey }) =>
      pressOpenCodeLogin(request.id, { key: request.key }),
    onSuccess: async (_response, request) => {
      await statusQuery.refetch()
      scheduleScreenshotRefreshAfterInteraction(request.id)
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
    if (
      !label.trim() ||
      !Number.isInteger(parsedChannelID) ||
      parsedChannelID <= 0
    ) {
      toast.error(t('Label and channel ID are required'))
      return
    }
    createMutation.mutate({
      label,
      channel_id: parsedChannelID,
    })
  }

  const selectedChannel = findChannelByID(channels, Number(channelID))

  const runSelected = (action: (id: number) => void) => {
    if (selectedAccountID === null) {
      toast.error(t('Select an OpenCode account first'))
      return
    }
    action(selectedAccountID)
  }

  const selectAccount = (accountID: number) => {
    if (
      shouldClearOpenCodeLoginScreenshotOnAccountSelect(selectedID, accountID)
    ) {
      setScreenshot('')
    }
    setSelectedID(accountID)
  }

  const handleScreenshotClick = (event: MouseEvent<HTMLImageElement>) => {
    if (selectedAccountID === null) return
    const rect = event.currentTarget.getBoundingClientRect()
    const point = mapContainedScreenshotClickToRemotePoint(
      { clientX: event.clientX, clientY: event.clientY },
      rect,
      { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }
    )
    if (point === null) return
    clickMutation.mutate({ id: selectedAccountID, ...point })
  }

  return (
    <SectionPageLayout fixedContent>
      <SectionPageLayout.Title>
        {t('OpenCode Accounts')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          onClick={() => refreshOpenCodeAccountPageData(refreshSources)}
          disabled={isOpenCodeAccountPageRefreshing(refreshSources)}
        >
          <RefreshCw data-icon='inline-start' />
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div
          className={cn(
            'grid h-full min-h-0 gap-4',
            openCodeAccountWorkspaceGridRows(usesFallbackCredentialKey)
          )}
        >
          {usesFallbackCredentialKey ? <CredentialKeySourceWarning /> : null}
          <div className='grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(480px,0.9fr)]'>
            <section className='bg-background grid min-w-0 grid-rows-[auto_minmax(0,1fr)] rounded-lg border'>
              <div className='grid gap-3 border-b p-3 md:grid-cols-[minmax(0,1fr)_minmax(220px,280px)_120px_auto]'>
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={t('Account label')}
                />
                <Select
                  items={channels.map((channel) => ({
                    value: String(channel.id),
                    label: formatChannelOption(channel, t),
                  }))}
                  value={selectedChannel ? String(selectedChannel.id) : null}
                  onValueChange={(value) => {
                    if (value !== null) {
                      setChannelID(value)
                    }
                  }}
                >
                  <SelectTrigger className='w-full min-w-0'>
                    <SelectValue placeholder={t('Select channel')} />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {channels.map((channel) => (
                        <SelectItem key={channel.id} value={String(channel.id)}>
                          {formatChannelOption(channel, t)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Input
                  value={channelID}
                  onChange={(event) => setChannelID(event.target.value)}
                  placeholder={t('ID')}
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
              <div className='min-h-0 overflow-auto'>
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
                        deleteDisabled={deleteMutation.isPending}
                        onSelect={() => selectAccount(account.id)}
                        onDelete={() =>
                          setDeleteTarget({
                            id: account.id,
                            label: account.label,
                          })
                        }
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
              </div>
            </section>

            <section className='bg-background grid min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 rounded-lg border p-3'>
              <div className='grid min-w-0 gap-2'>
                <div className='flex min-w-0 flex-wrap items-center gap-2'>
                  <Badge variant={loginStatus?.running ? 'default' : 'outline'}>
                    {loginStatus?.running ? t('Running') : t('Stopped')}
                  </Badge>
                  <span className='text-muted-foreground min-w-0 truncate text-sm'>
                    {loginStatus?.url ||
                      selectedAccount?.label ||
                      t('No account selected')}
                  </span>
                </div>
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
                  onClick={() =>
                    runSelected((id) => extractMutation.mutate(id))
                  }
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
                  onClick={() =>
                    runSelected((id) => activateMutation.mutate(id))
                  }
                  disabled={
                    activateMutation.isPending ||
                    selectedAccount?.activation_ready !== true
                  }
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
                <TooltipProvider>
                  <div className='flex min-w-0 flex-wrap items-center gap-1'>
                    {OPEN_CODE_PRESS_KEY_CONTROLS.map(({ key, label, Icon }) => {
                      const translatedLabel = t(label)
                      return (
                        <Tooltip key={key}>
                          <TooltipTrigger
                            render={
                              <Button
                                variant='outline'
                                size='icon-sm'
                                aria-label={translatedLabel}
                                disabled={
                                  selectedAccountID === null ||
                                  pressMutation.isPending
                                }
                                onClick={() =>
                                  runSelected((id) =>
                                    pressMutation.mutate({ id, key })
                                  )
                                }
                              >
                                <Icon />
                              </Button>
                            }
                          />
                          <TooltipContent>
                            <p>{translatedLabel}</p>
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                </TooltipProvider>
              </div>
            </section>
          </div>
        </div>
        <ConfirmDialog
          open={isOpenCodeAccountDeleteDialogOpen(deleteTarget)}
          onOpenChange={(open) => {
            if (deleteMutation.isPending) return
            if (!open) setDeleteTarget(null)
          }}
          title={t('Delete OpenCode account')}
          desc={t(
            'Delete OpenCode account "{{label}}"? Browser session state and profile will be purged before the account is removed. This action cannot be undone.',
            { label: deleteTarget?.label ?? '' }
          )}
          confirmText={t('Delete')}
          destructive
          isLoading={deleteMutation.isPending}
          disabled={
            !canConfirmOpenCodeAccountDelete(
              deleteTarget,
              deleteMutation.isPending
            )
          }
          handleConfirm={() => {
            if (!deleteTarget) return
            deleteMutation.mutate(deleteTarget.id)
          }}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

function CredentialKeySourceWarning() {
  const { t } = useTranslation()

  return (
    <div className='border-warning/40 bg-warning/10 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-sm'>
      <AlertTriangle className='mt-0.5 size-4 shrink-0' />
      <span className='min-w-0'>
        {t(
          'Credential encryption is using session-secret fallback. Set a stable crypto secret before importing production OpenCode accounts.'
        )}
      </span>
    </div>
  )
}

function findChannelByID(channels: Channel[], channelID: number) {
  if (!Number.isInteger(channelID)) {
    return null
  }
  return channels.find((channel) => channel.id === channelID) ?? null
}

function formatChannelOption(channel: Channel, t: (key: string) => string) {
  return `#${channel.id} ${channel.name} · ${t(getChannelTypeLabel(channel.type))}`
}

type AccountRowProps = {
  account: OpenCodeAccount
  selected: boolean
  deleteDisabled: boolean
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
  const credentialBroken =
    props.account.credential_integrity === 'decrypt_failed'
  const statusLabel = formatAccountReadiness(props.account, t)
  const statusVariant =
    props.account.active || props.account.activation_ready
      ? 'default'
      : 'outline'

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
        <Badge
          variant={
            secretCount >= 3 && !credentialBroken ? 'default' : 'outline'
          }
        >
          {credentialBroken ? <AlertTriangle data-icon='inline-start' /> : null}
          {secretCount}/3
        </Badge>
      </TableCell>
      <TableCell>
        <div className='flex flex-wrap items-center gap-2'>
          <Badge variant={statusVariant}>
            {credentialBroken ? (
              <AlertTriangle data-icon='inline-start' />
            ) : null}
            {statusLabel}
          </Badge>
          {!props.account.activation_ready &&
          props.account.missing_activation_fields.length > 0 ? (
            <span className='text-muted-foreground text-xs'>
              {formatMissingActivationFields(
                props.account.missing_activation_fields,
                t
              )}
            </span>
          ) : null}
          {props.account.quota_limit > 0 ? (
            <span className='text-muted-foreground text-xs'>
              {props.account.quota_used}/{props.account.quota_limit}
            </span>
          ) : null}
          {accountUsesSessionSecretFallback(props.account) ? (
            <Badge variant='outline'>
              <AlertTriangle data-icon='inline-start' />
              {t('Fallback key')}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className='text-right'>
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label={t('Delete')}
          disabled={props.deleteDisabled}
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

function formatMissingActivationFields(
  fields: string[],
  t: (key: string) => string
) {
  return fields
    .map((field) => {
      switch (field) {
        case 'api_key':
          return t('API key')
        case 'channel_id':
          return t('Channel')
        case 'credentials_decryptable':
          return t('Credentials')
        case 'codex_oauth_key':
          return t('Codex OAuth key')
        default:
          return field
      }
    })
    .join(', ')
}

function formatAccountReadiness(
  account: OpenCodeAccount,
  t: (key: string) => string
) {
  if (account.credential_integrity === 'decrypt_failed') {
    return t('Credential error')
  }
  if (account.active) {
    return t('Active')
  }
  if (account.activation_ready) {
    return t('Ready')
  }
  return t('Incomplete')
}

function accountUsesSessionSecretFallback(account: OpenCodeAccount) {
  return account.credential_key_source === 'session_secret_fallback'
}
