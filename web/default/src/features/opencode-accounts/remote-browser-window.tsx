import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  Check,
  CornerDownLeftIcon,
  DeleteIcon,
  Download,
  IndentIncreaseIcon,
  MousePointerClick,
  Play,
  RefreshCw,
  Square,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import {
  activateOpenCodeAccount,
  clickOpenCodeLogin,
  extractOpenCodeLogin,
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
  OPEN_CODE_INTERACTION_SCREENSHOT_REFRESH_DELAYS_MS,
  canRefreshOpenCodeLoginScreenshot,
  canUseOpenCodeLoginScreenshotResponse,
  mapContainedScreenshotClickToRemotePoint,
  normalizeOpenCodeLoginScreenshot,
  openCodeLoginStatusLabel,
  shouldClearOpenCodeLoginScreenshotForStatus,
  type OpenCodeLoginScreenshotImage,
} from './lib'
import type { OpenCodeAccount, OpenCodePressKey } from './types'

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
const EMPTY_OPEN_CODE_ACCOUNTS: OpenCodeAccount[] = []

type OpenCodeRemoteBrowserWindowProps = {
  initialAccountID: number | null
}

export function OpenCodeRemoteBrowserWindow(
  props: OpenCodeRemoteBrowserWindowProps
) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [selectedID, setSelectedID] = useState<number | null>(
    props.initialAccountID
  )
  const [textInput, setTextInput] = useState('')
  const [screenshot, setScreenshot] =
    useState<OpenCodeLoginScreenshotImage | null>(null)
  const selectedAccountIDRef = useRef<number | null>(selectedID)
  const screenshotPendingRef = useRef(false)
  const screenshotRefreshTimerRefs = useRef<ReturnType<typeof setTimeout>[]>([])

  const accountsQuery = useQuery({
    queryKey: ['opencode-accounts'],
    queryFn: listOpenCodeAccounts,
  })
  const accounts = accountsQuery.data?.data ?? EMPTY_OPEN_CODE_ACCOUNTS
  const selectedAccount =
    accounts.find((account) => account.id === selectedID) ?? null
  const selectedAccountID = selectedAccount?.id ?? selectedID
  selectedAccountIDRef.current = selectedAccountID

  useEffect(() => {
    if (selectedID !== null || accounts.length === 0) return
    setSelectedID(accounts[0].id)
  }, [accounts, selectedID])

  const statusQuery = useQuery({
    queryKey: ['opencode-login-status', selectedAccountID],
    queryFn: () => getOpenCodeLoginStatus(selectedAccountID as number),
    enabled: selectedAccountID !== null,
    refetchInterval: 2500,
    retry: false,
  })
  const loginStatus = statusQuery.data?.data

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
      setScreenshot(normalizeOpenCodeLoginScreenshot(response.data))
    },
  })
  screenshotPendingRef.current = screenshotMutation.isPending

  const clearScheduledScreenshotRefreshes = useCallback(() => {
    for (const timer of screenshotRefreshTimerRefs.current) {
      clearTimeout(timer)
    }
    screenshotRefreshTimerRefs.current = []
  }, [])

  const scheduleScreenshotRefreshAfterInteraction = useCallback(
    (accountID: number) => {
      clearScheduledScreenshotRefreshes()
      screenshotRefreshTimerRefs.current =
        OPEN_CODE_INTERACTION_SCREENSHOT_REFRESH_DELAYS_MS.map((delayMs) => {
          const timer = setTimeout(() => {
            screenshotRefreshTimerRefs.current =
              screenshotRefreshTimerRefs.current.filter(
                (activeTimer) => activeTimer !== timer
              )
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
          }, delayMs)
          return timer
        })
    },
    [clearScheduledScreenshotRefreshes, screenshotMutation]
  )

  useEffect(
    () => () => {
      clearScheduledScreenshotRefreshes()
    },
    [clearScheduledScreenshotRefreshes]
  )

  useEffect(() => {
    if (
      !shouldClearOpenCodeLoginScreenshotForStatus({
        running: loginStatus?.running,
        status: loginStatus?.status,
      })
    ) {
      return
    }
    clearScheduledScreenshotRefreshes()
    setScreenshot(null)
  }, [clearScheduledScreenshotRefreshes, loginStatus?.running, loginStatus?.status])

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
      await queryClient.invalidateQueries({ queryKey: ['opencode-accounts'] })
      toast.success(t('OpenCode account material extracted'))
    },
  })

  const quotaMutation = useMutation({
    mutationFn: refreshOpenCodeQuota,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['opencode-accounts'] })
      toast.success(t('OpenCode quota refreshed'))
    },
  })

  const activateMutation = useMutation({
    mutationFn: activateOpenCodeAccount,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['opencode-accounts'] })
      toast.success(t('OpenCode account activated'))
    },
  })

  const stopMutation = useMutation({
    mutationFn: stopOpenCodeLogin,
    onSuccess: async () => {
      clearScheduledScreenshotRefreshes()
      setScreenshot(null)
      await statusQuery.refetch()
      toast.success(t('OpenCode login session stopped'))
    },
  })

  const runSelected = (action: (id: number) => void) => {
    if (selectedAccountID === null) {
      toast.error(t('Select an OpenCode account first'))
      return
    }
    action(selectedAccountID)
  }

  const handleScreenshotClick = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    if (selectedAccountID === null || screenshot === null) return
    const rect = event.currentTarget.getBoundingClientRect()
    const point = mapContainedScreenshotClickToRemotePoint(
      { clientX: event.clientX, clientY: event.clientY },
      rect,
      { width: screenshot.width, height: screenshot.height }
    )
    if (point === null) return
    clickMutation.mutate({ id: selectedAccountID, ...point })
  }

  const selectedAccountValue =
    selectedAccountID === null ? null : String(selectedAccountID)
  const selectedReady = selectedAccount?.activation_ready === true

  return (
    <div className='bg-background grid h-svh min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] text-foreground'>
      <header className='grid gap-2 border-b px-3 py-2 lg:grid-cols-[minmax(260px,360px)_minmax(0,1fr)_auto] lg:items-center'>
        <Select
          items={accounts.map((account) => ({
            value: String(account.id),
            label: formatRemoteBrowserAccountOption(account),
          }))}
          value={selectedAccountValue}
          onValueChange={(value) => {
            if (value === null) return
            const nextID = Number(value)
            if (!Number.isInteger(nextID) || nextID <= 0) return
            clearScheduledScreenshotRefreshes()
            setScreenshot(null)
            setSelectedID(nextID)
          }}
        >
          <SelectTrigger className='w-full min-w-0'>
            <SelectValue placeholder={t('Select account')} />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={String(account.id)}>
                  {formatRemoteBrowserAccountOption(account)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className='flex min-w-0 items-center gap-2'>
          <Badge variant={loginStatus?.running ? 'default' : 'outline'}>
            {loginStatus?.running ? t('Running') : t('Stopped')}
          </Badge>
          <span className='text-muted-foreground min-w-0 truncate text-sm'>
            {openCodeLoginStatusLabel({
              title: loginStatus?.title,
              url: loginStatus?.url,
              accountLabel: selectedAccount?.label,
              fallback: t('No account selected'),
            })}
          </span>
        </div>
        <div className='flex flex-wrap items-center gap-2 lg:justify-end'>
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
            onClick={() => runSelected((id) => screenshotMutation.mutate(id))}
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
            disabled={activateMutation.isPending || !selectedReady}
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
      </header>

      <main className='min-h-0 bg-muted/20 p-2'>
        <div className='bg-background flex h-full min-h-0 items-center justify-center overflow-hidden rounded-md border'>
          {screenshot ? (
            <button
              type='button'
              aria-label={t('Remote browser')}
              className={cn(
                'focus-visible:ring-ring relative flex h-full max-h-full w-full max-w-full cursor-crosshair appearance-none',
                'items-center justify-center overflow-hidden rounded-none border-0 bg-transparent p-0 focus-visible:ring-2 focus-visible:ring-offset-2'
              )}
              onPointerUp={handleScreenshotClick}
            >
              <img
                src={`data:image/png;base64,${screenshot.imageBase64}`}
                alt=''
                draggable={false}
                className='pointer-events-none h-full max-h-full w-full max-w-full object-contain select-none'
              />
            </button>
          ) : (
            <span className='text-muted-foreground text-sm'>
              {t('Start login and capture a screenshot')}
            </span>
          )}
        </div>
      </main>

      <footer className='grid gap-2 border-t p-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center'>
        <div className='grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]'>
          <Input
            value={textInput}
            onChange={(event) => setTextInput(event.target.value)}
            placeholder={t('Text to type into remote browser')}
          />
          <Button
            variant='outline'
            onClick={() =>
              runSelected((id) => keyMutation.mutate({ id, text: textInput }))
            }
            disabled={!textInput || keyMutation.isPending}
          >
            {t('Type Text')}
          </Button>
        </div>
        <TooltipProvider>
          <div className='flex min-w-0 flex-wrap items-center gap-1 lg:justify-end'>
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
                          selectedAccountID === null || pressMutation.isPending
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
      </footer>
    </div>
  )
}

function formatRemoteBrowserAccountOption(account: OpenCodeAccount) {
  const email = account.email_masked ? ` / ${account.email_masked}` : ''
  return `#${account.id} ${account.label}${email}`
}
