// @ts-nocheck
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  Cpu,
  GitBranch,
  History,
  LineChart,
  ListOrdered,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Square,
  Trash2,
  Wallet,
} from 'lucide-react'
import { AuthGate, ConnectButton, logoutAuth, WalletProviders } from './walletAuth'
import { toast } from 'sonner'
import { LiveCountdown, LiveClock, LiveTimeAgo, fmtTimeMs, POLY_POLL_MS } from './polyTimers'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import ChatPanel from '@/components/ChatPanel'
import OrderBook from '@/components/OrderBook'
import ChartPanel from '@/components/ChartPanel'
import SpotChart from '@/components/SpotChart'
import NotificationsPanel from '@/components/NotificationsPanel'
import LiveTickStrip from '@/components/LiveTickStrip'
import SystemFlow from '@/components/SystemFlow'
import MlBay from '@/components/MlBay'
import AccountPage from '@/pages/AccountPage'
import ProcessPage from '@/pages/ProcessPage'

function addr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'
}

function money(n, digits = 2) {
  const v = Number(n || 0)
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(digits)}`
}

function historyTime(timestamp) {
  const value = Number(timestamp || 0)
  if (!value) return '—'
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function moneyCompact(n) {
  const v = Number(n || 0)
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}k`
  return `${sign}$${a.toFixed(0)}`
}

function marketBook(m) {
  return m?.depth || m?.book || null
}

function spendableCash(readiness = {}, portfolio = {}) {
  const spend = readiness.spendableBalance
  if (spend != null && Number.isFinite(Number(spend))) return Number(spend)
  if (portfolio.cash != null && Number.isFinite(Number(portfolio.cash))) return Number(portfolio.cash)
  const deposit = readiness.depositPusd
  if (deposit != null && Number.isFinite(Number(deposit))) return Number(deposit)
  return Number(readiness.clobBalance || 0)
}

function ModeRail({ mode, onChange, disabled }) {
  const live = mode === 'live'
  return (
    <div className="mode-rail" role="group" aria-label="Trading mode">
      <button
        type="button"
        data-mode="paper"
        data-active={!live}
        disabled={disabled}
        onClick={() => onChange?.('paper')}
      >
        Paper
      </button>
      <button
        type="button"
        data-mode="live"
        data-active={live}
        disabled={disabled}
        onClick={() => onChange?.('live')}
      >
        Live
      </button>
    </div>
  )
}

function MarketDetailTiles({ market }) {
  if (!market) return null
  const book = marketBook(market)
  const up = book?.up
  const down = book?.down
  const tiles = [
    { lbl: 'Liquidity', val: moneyCompact(market.liquidity) },
    { lbl: 'Volume', val: moneyCompact(market.volume) },
    { lbl: 'Spread', val: market.spread != null ? money(market.spread, 3) : '—' },
    { lbl: 'Implied', val: market.impliedWinner || '—' },
    { lbl: 'UP bid', val: up?.bestBid != null ? money(up.bestBid, 3) : '—' },
    { lbl: 'UP ask', val: up?.bestAsk != null ? money(up.bestAsk, 3) : '—' },
    { lbl: 'DN bid', val: down?.bestBid != null ? money(down.bestBid, 3) : '—' },
    { lbl: 'DN ask', val: down?.bestAsk != null ? money(down.bestAsk, 3) : '—' },
    {
      lbl: 'UP imb',
      val: up?.imbalance != null ? `${(up.imbalance * 100).toFixed(0)}%` : '—',
    },
    {
      lbl: 'DN imb',
      val: down?.imbalance != null ? `${(down.imbalance * 100).toFixed(0)}%` : '—',
    },
    {
      lbl: 'Arb gap',
      val: book?.arbGap != null ? money(book.arbGap, 3) : '—',
    },
    {
      lbl: 'Orders',
      val: market.acceptingOrders === false ? 'closed' : 'open',
    },
  ]
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.lbl} className="data-tile">
          <div className="lbl">{t.lbl}</div>
          <div className="val text-xs sm:text-sm">{t.val}</div>
        </div>
      ))}
    </div>
  )
}

function usePolyState(intervalMs = POLY_POLL_MS) {
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    let es
    let reconnectTimer
    let failStreak = 0
    let backoffMs = 800

    async function poll() {
      try {
        const r = await fetch('/api/poly/state?lean=1')
        if (!r.ok) throw new Error(`API ${r.status}`)
        const data = await r.json()
        if (active) {
          setState((prev) => {
            // Merge lean stream with full charts if we already have them from charts endpoint
            if (!prev) return data
            // Drop out-of-order responses — a stale poll landing after a toggle
            // must not overwrite the newer running/config state
            if (prev.cycle?.serverTime && data.cycle?.serverTime && data.cycle.serverTime < prev.cycle.serverTime) {
              return prev
            }
            return {
              ...data,
              charts: Object.keys(data.charts || {}).length ? data.charts : prev.charts,
              readiness: data.readiness?.liveReady != null ? { ...prev.readiness, ...data.readiness } : data.readiness,
            }
          })
          failStreak = 0
          setError(null)
        }
      } catch (err) {
        failStreak += 1
        if (active && failStreak >= 3) setError(err.message || 'API unreachable')
      }
    }

    function connectSSE() {
      if (!active) return
      try {
        es = new EventSource('/api/poly/stream')
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data)
            if (active) {
              setState((prev) => {
                if (prev?.cycle?.serverTime && data.cycle?.serverTime && data.cycle.serverTime < prev.cycle.serverTime) {
                  return prev
                }
                return {
                  ...data,
                  charts: prev?.charts && !(data.charts && Object.keys(data.charts).length)
                    ? prev.charts
                    : (data.charts || {}),
                }
              })
              failStreak = 0
              setError(null)
              backoffMs = 800
            }
          } catch {}
        }
        es.onerror = () => {
          try { es.close() } catch {}
          es = null
          if (!active) return
          // Soft reconnect — do not surface as fatal stream error
          reconnectTimer = setTimeout(() => {
            backoffMs = Math.min(12000, Math.round(backoffMs * 1.6))
            connectSSE()
          }, backoffMs)
        }
      } catch {}
    }

    poll()
    connectSSE()
    const id = setInterval(poll, intervalMs)
    return () => {
      active = false
      clearInterval(id)
      clearTimeout(reconnectTimer)
      if (es) try { es.close() } catch {}
    }
  }, [intervalMs])

  return { state, error, setState }
}

function PageIntro({ title, description }) {
  return (
    <div className="pb-1">
      <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
      {description ? (
        <p className="text-muted-foreground text-[0.7rem] leading-snug">{description}</p>
      ) : null}
    </div>
  )
}

function Kpi({ label, value, tone }) {
  return (
    <Card className="gap-0 border-border/60 bg-card/80 py-0 shadow-none">
      <CardHeader className="gap-0.5 px-2.5 py-2.5 sm:px-3 sm:py-3">
        <CardDescription className="text-[0.6rem] font-medium tracking-[0.08em] uppercase sm:text-[0.65rem]">
          {label}
        </CardDescription>
        <CardTitle
          className={cn(
            'font-mono text-base tabular-nums tracking-tight sm:text-xl',
            tone === 'up' && 'text-primary',
            tone === 'down' && 'text-destructive',
            tone === 'muted' && 'text-muted-foreground',
          )}
        >
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  )
}

function BehaviorForm({
  cfg,
  profiles,
  onSave,
  configSessions = [],
  onSaveSnapshot,
  onRestoreSnapshot,
  onResetPaper,
  onResetLive,
}) {
  const [draft, setDraft] = useState(cfg)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!dirty) setDraft(cfg)
  }, [cfg, dirty])

  const patch = (partial) => {
    setDirty(true)
    setDraft((prev) => ({ ...prev, ...partial }))
  }

  const switchDraftMode = (nextMode) => {
    const selected = nextMode === 'live' ? profiles?.live : profiles?.paper
    setDirty(true)
    setDraft((prev) => ({
      ...prev,
      ...(selected || {}),
      mode: nextMode,
    }))
  }

  const normalizeDraft = (currentDraft) => {
    const out = { ...currentDraft }
    const min = Number(out.minPositionSize)
    const max = Number(out.maxPositionSize)
    if (Number.isFinite(min) && Number.isFinite(max) && max < min) {
      out.maxPositionSize = min
    }
    return out
  }

  const numField = (key, label, step = '1') => (
    <Field>
      <FieldLabel htmlFor={key}>{label}</FieldLabel>
      <Input
        id={key}
        type="number"
        inputMode="decimal"
        step={step}
        value={draft[key] ?? ''}
        onChange={(e) => patch({ [key]: Number(e.target.value) })}
      />
    </Field>
  )

  return (
    <form
      className="flex flex-col gap-2.5 sm:gap-3"
      onSubmit={async (e) => {
        e.preventDefault()
        const normalized = normalizeDraft(draft)
        if (normalized.maxPositionSize !== draft.maxPositionSize) {
          toast.message('Max $ adjusted to be >= Min $')
        }
        await onSave(normalized)
        setDraft(normalized)
        setDirty(false)
      }}
    >
      <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
        Editing <span className="font-bold tracking-wider text-primary">{String(draft.mode || 'paper').toUpperCase()}</span> strategy
        — paper and live knobs are stored separately.
      </div>
      <FieldSet>
        <FieldGroup>
          <Field>
            <FieldLabel>Mode</FieldLabel>
            <Select value={draft.mode || 'paper'} onValueChange={switchDraftMode}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="live">Live</SelectItem>
                  <SelectItem value="paper">Paper</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Announce before trade</FieldTitle>
              <FieldDescription>Show targets and wait for approve</FieldDescription>
            </FieldContent>
            <Switch
              checked={draft.announceBeforeTrade !== false}
              onCheckedChange={(announceBeforeTrade) => patch({ announceBeforeTrade })}
            />
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Auto-approve paper</FieldTitle>
              <FieldDescription>Skip confirm in paper mode</FieldDescription>
            </FieldContent>
            <Switch
              checked={!!draft.autoApprovePaper}
              onCheckedChange={(autoApprovePaper) => patch({ autoApprovePaper })}
            />
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Auto-approve live</FieldTitle>
              <FieldDescription>Execute live signals without manual approve</FieldDescription>
            </FieldContent>
            <Switch
              checked={!!draft.autoApproveLive}
              onCheckedChange={(autoApproveLive) => patch({ autoApproveLive })}
            />
          </Field>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldGroup>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button type="button" variant="outline" onClick={onSaveSnapshot}>
              <Save data-icon="inline-start" />
              Save config snapshot
            </Button>
            <Button type="button" variant="destructive" onClick={onResetPaper}>
              <RotateCcw data-icon="inline-start" />
              Reset paper data
            </Button>
            {onResetLive && (
              <Button type="button" variant="destructive" className="sm:col-span-2" onClick={onResetLive}>
                <RotateCcw data-icon="inline-start" />
                Normalize live account
              </Button>
            )}
          </div>
          <div className="rounded-md border border-border/70 p-2">
            <div className="mb-2 text-xs font-semibold">Saved configs</div>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {configSessions.length === 0 ? (
                <div className="text-muted-foreground text-xs">No saved configs yet.</div>
              ) : (
                configSessions.slice(0, 8).map((session) => (
                  <div key={session.id} className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{session.label}</div>
                      <div className="text-muted-foreground text-[0.6rem]">
                        {session.mode?.toUpperCase()} · {historyTime(session.createdAt)}
                        {' · '}P {money(session.analysis?.paper?.pnl)}
                      </div>
                    </div>
                    <Button type="button" size="xs" variant="ghost" onClick={() => onRestoreSnapshot?.(session.id)}>
                      <ArchiveRestore data-icon="inline-start" />
                      Restore
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldGroup className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3">
          {numField('announceTimeoutSec', 'Announce timeout (s)')}
          {numField('minConfidence', 'Min confidence', '0.05')}
          {numField('kellyFraction', 'Kelly fraction', '0.05')}
          {numField('maxPositionPct', 'Max bankroll %', '0.05')}
          {numField('minPositionSize', 'Min $', '0.1')}
          {numField('maxPositionSize', 'Max $', '1')}
          {numField('tpPctLow', 'TP low %')}
          {numField('tpPctHigh', 'TP high %')}
          {numField('slPct', 'SL %')}
          {numField('minAdaptiveSlPct', 'Min adaptive SL %', '0.5')}
          {numField('partialTpFrac', 'Partial TP frac', '0.01')}
          {numField('partialSellPct', 'Partial sell %', '0.01')}
          {numField('maxOpenPositions', 'Max open positions')}
          {numField('minPrice', 'Min price', '0.01')}
          {numField('maxPrice', 'Max price', '0.01')}
          {numField('minRemainingSec', 'Min secs left')}
          {numField('aggScaleMultiplier', 'Scale multiplier', '0.1')}
          {numField('certaintyMaxPct', 'Certainty max %', '0.05')}
          {numField('certaintyMaxUsd', 'Certainty max $', '1')}
          {numField('arbBankrollFrac', 'Arb bankroll frac', '0.05')}
          {numField('arbMaxUsd', 'Arb max $', '1')}
          {numField('governorDrawdownPct', 'Governor breaker %', '0.01')}
          {numField('governorRevertTrades', 'Governor revert trades')}
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Adaptive SL</FieldTitle>
              <FieldDescription>Tighten to ~5% when loss grows + confidence drops</FieldDescription>
            </FieldContent>
            <Switch
              checked={draft.adaptiveSl !== false}
              onCheckedChange={(adaptiveSl) => patch({ adaptiveSl })}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>LLM optimize</FieldTitle>
              <FieldDescription>Tune Kelly / TP / SL from session performance</FieldDescription>
            </FieldContent>
            <Switch
              checked={draft.llmOptimize !== false}
              onCheckedChange={(llmOptimize) => patch({ llmOptimize })}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Regime governor</FieldTitle>
              <FieldDescription>Auto-switch scalp / trend-ride / arb-only in-flight (drawdown breaker + auto-revert)</FieldDescription>
            </FieldContent>
            <Switch
              checked={draft.governorEnabled !== false}
              onCheckedChange={(governorEnabled) => patch({ governorEnabled })}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="signals">Use signals</FieldLabel>
            <Switch
              id="signals"
              checked={draft.useSignals !== false}
              onCheckedChange={(useSignals) => patch({ useSignals })}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="kelly">Kelly sizing</FieldLabel>
            <Switch
              id="kelly"
              checked={draft.useKellySizing !== false}
              onCheckedChange={(useKellySizing) => patch({ useKellySizing })}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Aggressive scaling</FieldTitle>
              <FieldDescription>Multiply Kelly size</FieldDescription>
            </FieldContent>
            <Switch
              checked={!!draft.useAggressiveScaling}
              onCheckedChange={(useAggressiveScaling) => patch({ useAggressiveScaling })}
            />
          </Field>
        </FieldGroup>
      </FieldSet>

      <Alert>
        <AlertTitle>Expected exits</AlertTitle>
        <AlertDescription className="font-mono text-xs">
          TP {draft.tpPctLow}–{draft.tpPctHigh}% · SL {draft.slPct}% · adaptive ≥{draft.minAdaptiveSlPct ?? 4}% · conf-scaled
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={!dirty} className="h-11 flex-1">
          Save behavior
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 flex-1"
          onClick={async () => {
            try {
              const r = await fetch('/api/poly/optimize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apply: true, useLlm: true }),
              })
              const d = await r.json()
              if (d.ok === false && d.skipped) toast.message('Optimizer busy')
              else if (d.ok) {
                toast.success(d.applied ? `Optimized: ${Object.keys(d.patch || {}).join(', ') || 'no change'}` : 'Optimizer ran (no patch)')
              } else toast.error(d.error || 'Optimize failed')
            } catch (e) {
              toast.error(e.message || 'Optimize failed')
            }
          }}
        >
          Optimize now
        </Button>
      </div>
    </form>
  )
}

function TradeApproveDialog({ pending, onApprove, onReject, busy }) {
  const open = pending.length > 0
  const p = pending[0]
  const plan = p?.plan || {}
  const leftSec = p ? Math.max(0, Math.ceil(((p.expiresAt || 0) - Date.now()) / 1000)) : 0

  return (
    <Dialog open={open}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-base sm:text-lg">
            Trade ready — {p?.symbol} {p?.outcome?.toUpperCase()}
          </DialogTitle>
          <DialogDescription>
            Review targets before this order hits the book. Expires in {leftSec}s.
          </DialogDescription>
        </DialogHeader>

        {p && (
          <div className="grid grid-cols-2 gap-2 text-sm sm:gap-3">
            <div className="rounded-lg border border-border bg-muted/40 p-2.5 sm:p-3">
              <div className="text-muted-foreground text-[0.65rem] uppercase tracking-wide">Entry</div>
              <div className="font-mono text-sm sm:text-base">{money(plan.entryPrice, 3)}</div>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-2.5 sm:p-3">
              <div className="text-muted-foreground text-[0.65rem] uppercase tracking-wide">Size</div>
              <div className="font-mono text-sm sm:text-base">
                {money(plan.costEst)} · ~{plan.shares} sh
              </div>
            </div>
            <div className="rounded-lg border border-primary/40 bg-primary/10 p-2.5 sm:p-3">
              <div className="text-muted-foreground text-[0.65rem] uppercase tracking-wide">Take profit</div>
              <div className="font-mono text-sm text-primary sm:text-base">
                +{plan.targetTp}% → {money(plan.tpPrice, 3)}
              </div>
              <div className="text-muted-foreground font-mono text-xs">+{money(plan.tpPnl)}</div>
            </div>
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 sm:p-3">
              <div className="text-muted-foreground text-[0.65rem] uppercase tracking-wide">Stop loss</div>
              <div className="font-mono text-sm text-destructive sm:text-base">
                -{plan.slPct}% → {money(plan.slPrice, 3)}
              </div>
              <div className="text-muted-foreground font-mono text-xs">{money(plan.slPnl)}</div>
            </div>
            <div className="col-span-2 rounded-lg border border-border p-2.5 sm:p-3">
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Conf <b className="text-foreground font-mono">{((plan.confidence || 0) * 100).toFixed(0)}%</b>
                </span>
                <span>
                  Window <b className="text-foreground font-mono">{plan.remaining}s</b>
                </span>
                <span>
                  Mode <b className="text-foreground font-mono">{p.mode}</b>
                </span>
                {pending.length > 1 && <span>+{pending.length - 1} more pending</span>}
              </div>
              {plan.thesis && <p className="mt-2 text-sm text-muted-foreground">{plan.thesis}</p>}
            </div>
          </div>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="outline" className="h-11 w-full sm:w-auto" disabled={busy} onClick={() => onReject(p.id)}>
            Skip
          </Button>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            {pending.length > 1 && (
              <Button variant="secondary" className="h-11" disabled={busy} onClick={() => onApprove('all')}>
                Approve all
              </Button>
            )}
            <Button className="h-11" disabled={busy} onClick={() => onApprove(p.id)}>
              Approve trade
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MarketCards({ markets, onSelectBook, selectedSlug }) {
  return (
    <div className="flex flex-col gap-2 p-2 lg:hidden">
      {markets.map((m, i) => {
        const book = marketBook(m)
        const selected = selectedSlug && m.slug === selectedSlug
        return (
          <div
            key={i}
            role={onSelectBook ? 'button' : undefined}
            tabIndex={onSelectBook ? 0 : undefined}
            onClick={() => onSelectBook?.(m)}
            onKeyDown={(e) => {
              if (onSelectBook && (e.key === 'Enter' || e.key === ' ')) onSelectBook(m)
            }}
            className={cn(
              'rounded-lg border border-border/70 bg-card/60 p-2.5 sm:p-3',
              onSelectBook && 'cursor-pointer hover:border-primary/50',
              selected && 'border-primary/60 bg-primary/10',
              (m.decision?.action === 'buy' || m.decision?.action === 'announce') &&
                'border-primary/40 bg-primary/5',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <div className="text-base font-semibold">{m.symbol}</div>
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-[0.45rem]',
                      m.windowStatus === 'LIVE' &&
                        'border-[#a3e635]/40 bg-[#a3e635]/15 text-[#a3e635]',
                      m.windowStatus === 'ENDING' &&
                        'border-amber-400/40 bg-amber-400/10 text-amber-400',
                      m.windowStatus === 'RESOLVED' &&
                        'border-muted-foreground/40 text-muted-foreground',
                      m.windowStatus === 'NEXT' && 'text-muted-foreground',
                    )}
                  >
                    {m.windowStatus || (m.isCurrent ? 'LIVE' : 'NEXT')}
                  </Badge>
                </div>
                <div className="text-muted-foreground font-mono text-[0.65rem]">{m.slug}</div>
              </div>
              <Badge
                variant={
                  m.decision?.action === 'announce'
                    ? 'outline'
                    : m.decision?.action === 'buy'
                      ? 'default'
                      : 'secondary'
                }
              >
                {(m.decision?.summary || m.action || 'hold').slice(0, 28)}
              </Badge>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-xs">
              <div>
                <div className="text-muted-foreground uppercase">Up</div>
                <div>{money(m.prices?.up, 3)}</div>
                <div className="text-muted-foreground text-[0.55rem]">
                  {book?.up?.bestBid != null
                    ? `${money(book.up.bestBid, 2)}/${money(book.up.bestAsk, 2)}`
                    : 'bid/ask —'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground uppercase">Down</div>
                <div>{money(m.prices?.down, 3)}</div>
                <div className="text-muted-foreground text-[0.55rem]">
                  {book?.down?.bestBid != null
                    ? `${money(book.down.bestBid, 2)}/${money(book.down.bestAsk, 2)}`
                    : 'bid/ask —'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground uppercase">Left</div>
                <div>
                  <LiveCountdown
                    endAtMs={m.endAtMs}
                    fallbackMs={m.remainingMs}
                    fallbackSeconds={m.remaining}
                  />
                </div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[0.65rem]">
              <div>
                <span className="text-muted-foreground">Liq </span>
                {moneyCompact(m.liquidity)}
              </div>
              <div>
                <span className="text-muted-foreground">Vol </span>
                {moneyCompact(m.volume)}
              </div>
              <div>
                <span className="text-muted-foreground">Arb </span>
                {book?.arbGap != null ? money(book.arbGap, 3) : '—'}
              </div>
            </div>
            <div className="text-muted-foreground mt-2 text-xs">
              {m.signal
                ? `${m.signal.direction?.toUpperCase()} ${(m.signal.confidence * 100).toFixed(0)}%`
                : 'No signal'}
              {m.sizingPreview?.sizeUsd ? ` · Kelly ${money(m.sizingPreview.sizeUsd)}` : ''}
              {m.impliedWinner ? ` · → ${m.impliedWinner}` : ''}
            </div>
            {selected && (
              <div className="mt-3">
                <MarketDetailTiles market={m} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function MarketTable({ markets, compact = false, onSelectBook, selectedSlug }) {
  if (!markets.length) {
    return (
      <Empty className="border-0 py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LineChart />
          </EmptyMedia>
          <EmptyTitle>No live markets</EmptyTitle>
          <EmptyDescription>Waiting for the next BTC/ETH 5m window.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <>
      <MarketCards markets={markets} onSelectBook={onSelectBook} selectedSlug={selectedSlug} />
      <div className="hidden lg:block">
        <ScrollArea className={compact ? 'h-[260px]' : 'h-[min(60vh,520px)]'}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>UP mid</TableHead>
                <TableHead>DN mid</TableHead>
                <TableHead>UP bid/ask</TableHead>
                <TableHead>DN bid/ask</TableHead>
                <TableHead>Liq</TableHead>
                {!compact && <TableHead>Vol</TableHead>}
                {!compact && <TableHead>Arb</TableHead>}
                <TableHead>Left</TableHead>
                <TableHead>Signal</TableHead>
                <TableHead>Decision</TableHead>
                {!compact && <TableHead>Kelly</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {markets.map((m, i) => {
                const book = marketBook(m)
                const selected = selectedSlug && m.slug === selectedSlug
                return (
                  <TableRow
                    key={i}
                    onClick={() => onSelectBook?.(m)}
                    className={cn(
                      onSelectBook && 'cursor-pointer',
                      selected && 'bg-primary/10',
                      m.decision?.action === 'buy' || m.decision?.action === 'announce'
                        ? 'bg-primary/5'
                        : undefined,
                    )}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1.5 font-medium">
                        {m.symbol}
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[0.4rem]',
                            m.windowStatus === 'LIVE' &&
                              'border-[#a3e635]/40 bg-[#a3e635]/15 text-[#a3e635]',
                            m.windowStatus === 'ENDING' && 'border-amber-400/40 text-amber-400',
                            m.windowStatus === 'RESOLVED' && 'text-muted-foreground',
                          )}
                        >
                          {m.windowStatus || (m.isCurrent ? 'LIVE' : 'NEXT')}
                        </Badge>
                      </div>
                      <div className="text-muted-foreground max-w-[140px] truncate font-mono text-[0.65rem]">
                        {m.slug}
                      </div>
                      {m.impliedWinner && (
                        <div className="text-primary mt-0.5 font-mono text-[0.55rem]">
                          → {m.impliedWinner}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{money(m.prices?.up, 3)}</TableCell>
                    <TableCell className="font-mono">{money(m.prices?.down, 3)}</TableCell>
                    <TableCell className="font-mono text-[0.65rem]">
                      {book?.up?.bestBid != null
                        ? `${Number(book.up.bestBid).toFixed(2)}/${Number(book.up.bestAsk).toFixed(2)}`
                        : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-[0.65rem]">
                      {book?.down?.bestBid != null
                        ? `${Number(book.down.bestBid).toFixed(2)}/${Number(book.down.bestAsk).toFixed(2)}`
                        : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{moneyCompact(m.liquidity)}</TableCell>
                    {!compact && (
                      <TableCell className="font-mono text-xs">{moneyCompact(m.volume)}</TableCell>
                    )}
                    {!compact && (
                      <TableCell className="font-mono text-xs">
                        {book?.arbGap != null ? money(book.arbGap, 3) : '—'}
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-xs">
                      <LiveCountdown
                        endAtMs={m.endAtMs}
                        fallbackMs={m.remainingMs}
                        fallbackSeconds={m.remaining}
                      />
                    </TableCell>
                    <TableCell className="text-xs">
                      {m.signal
                        ? `${m.signal.direction?.toUpperCase()} ${(m.signal.confidence * 100).toFixed(0)}%`
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          m.decision?.action === 'announce'
                            ? 'outline'
                            : m.decision?.action === 'buy'
                              ? 'default'
                              : 'secondary'
                        }
                      >
                        {(m.decision?.summary || m.action || 'hold').slice(0, 42)}
                      </Badge>
                    </TableCell>
                    {!compact && (
                      <TableCell className="font-mono text-xs">
                        {m.sizingPreview?.sizeUsd ? money(m.sizingPreview.sizeUsd) : '—'}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </ScrollArea>
        {selectedSlug && (
          <div className="border-t border-border/60 p-3">
            <MarketDetailTiles market={markets.find((m) => m.slug === selectedSlug)} />
          </div>
        )}
      </div>
    </>
  )
}

function BottomNav({ tab, setTab, items, badges = {} }) {
  const mobileItems = items.filter((i) => i.mobile !== false)
  return (
    <nav
      className="bg-background/95 fixed inset-x-0 bottom-0 z-40 border-t border-border/80 backdrop-blur-md lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {mobileItems.map(({ id, label, shortLabel, icon: Icon }) => {
          const active = tab === id
          const badge = badges[id]
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'relative flex min-h-12 min-w-[4.25rem] shrink-0 flex-col items-center justify-center gap-0.5 px-2 text-[0.6rem] transition-colors',
                active ? 'text-primary border-t-2 border-primary' : 'text-muted-foreground border-t-2 border-transparent',
                badge?.pulse && !active && 'text-amber-400',
              )}
            >
              <Icon className={cn('size-5', active && 'text-primary')} />
              <span className="truncate">{shortLabel || label}</span>
              {badge?.count > 0 && (
                <span className="absolute top-1 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.55rem] font-bold text-black">
                  {badge.count > 9 ? '9+' : badge.count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function TopNavTabs({ tab, setTab, items, badges = {}, cycleLabel }) {
  const idx = Math.max(0, items.findIndex((i) => i.id === tab))
  const prev = items[(idx - 1 + items.length) % items.length]
  const next = items[(idx + 1) % items.length]
  return (
    <div className="hidden items-center gap-1 border-t border-border/50 px-2 py-1 lg:flex sm:px-3">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 shrink-0 px-0"
        onClick={() => setTab(prev.id)}
        aria-label={`Previous: ${prev.label}`}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          const badge = badges[id]
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'relative inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[0.65rem] tracking-wide transition-colors',
                active
                  ? 'bg-primary/15 text-primary'
                  : badge?.pulse
                    ? 'text-amber-400 hover:bg-amber-400/10'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {label}
              {badge?.count > 0 && (
                <span className="rounded-full bg-primary/90 px-1.5 text-[0.55rem] font-bold text-black">
                  {badge.count}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {cycleLabel && (
        <span className="text-muted-foreground hidden shrink-0 font-mono text-[0.6rem] xl:inline">
          {cycleLabel}
        </span>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 shrink-0 px-0"
        onClick={() => setTab(next.id)}
        aria-label={`Next: ${next.label}`}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )
}

function PolyShell({
  poly,
  error,
  tab,
  setTab,
  navItems,
  syncing,
  sync,
  act,
  setCfg,
  settingsOpen,
  setSettingsOpen,
  busy,
  approve,
  toggleBot,
  botBusy,
  saveConfigSnapshot,
  restoreConfigSnapshot,
  resetPaperData,
  resetLiveData,
  refreshState,
}) {
  const { setOpenMobile, isMobile } = useSidebar()

  const cfg = poly.config || {}
  const [modeBusy, setModeBusy] = useState(false)
  const [modeOverride, setModeOverride] = useState(null)
  // Single effective mode drives every panel so LIVE/PAPER can never half-switch:
  // the optimistic override flips the whole app instantly, then the refetch confirms.
  const mode = modeOverride || poly.mode || cfg.mode || 'paper'
  const readiness = poly.readiness || {}
  const portfolio = poly.portfolio || {}
  const markets = poly.markets || []
  const liveMarkets = markets.filter((m) => m.isCurrent !== false && m.prices?.up)
  const openPositions = poly.positions || []
  const botPositions = poly.botPositions || []
  const pending = poly.pendingTrades || []
  const openBot = botPositions.filter((p) => !p.closed)
  const remMs = poly.cycle?.remainingMs ?? poly.windows?.current?.remainingMs ?? 0
  const remSecNav = Math.max(0, Math.ceil(remMs / 1000))
  const cycleLabel = `WINDOW LEFT ${Math.floor(remSecNav / 60)}:${String(remSecNav % 60).padStart(2, '0')} · ${poly.cycle?.class || 'OPEN'}`
  const navBadges = {
    positions: { count: openBot.length, pulse: openBot.some((p) => Number(p.gainPct || 0) <= -5) },
    history: { count: (poly.cashAudit?.issues || []).length, pulse: poly.cashAudit?.ok === false },
    account: {
      count: (poly.cashAudit?.notes || []).length + (poly.cashAudit?.issues || []).length,
      pulse: poly.cashAudit?.ok === false,
    },
    overview: { count: pending.length, pulse: pending.length > 0 },
    process: { count: poly.windows?.current?.opens || 0, pulse: remSecNav <= 30 },
  }
  const audit = poly.audit || {}
  const inferredLiveReady = readiness.liveReady === true || (
    mode === 'live'
    && !!readiness.apiReady
    && readiness.ownerMatches !== false
    && Number(readiness.spendableBalance ?? readiness.clobBalance ?? 0) >= 0.4
  )
  const liveOk = mode === 'paper' || inferredLiveReady
  const cash = portfolio.cash ?? 0
  const livePnl = portfolio.netPnl ?? portfolio.cashPnl ?? portfolio.sessionPnl ?? 0
  const realizedPnl = portfolio.realizedPnl ?? 0
  const unrealizedPnl = portfolio.unrealizedPnl ?? 0
  const botPnl = mode === 'paper' ? portfolio.realizedPnlPaper ?? realizedPnl : portfolio.realizedPnl ?? 0
  const limits = portfolio.limits || {}
  const isPaper = mode === 'paper'
  const paperBankroll = portfolio.paperBankroll
  const [bookMarket, setBookMarket] = useState(null)
  const [chartPack, setChartPack] = useState({ charts: {}, mlTraces: {} })
  const [notifOpen, setNotifOpen] = useState(false)
  const displayMode = mode
  useEffect(() => {
    if (modeOverride && cfg.mode === modeOverride) setModeOverride(null)
  }, [cfg.mode, modeOverride])
  const activeBook = bookMarket || liveMarkets[0] || null
  const bookLabel = activeBook ? `${activeBook.symbol}` : ''
  const chartMarket = activeBook
  const chartTicks =
    (chartMarket?.slug && (chartPack.charts?.[chartMarket.slug] || poly.charts?.[chartMarket.slug])) ||
    []
  const chartMl =
    chartMarket?.symbol &&
    (chartPack.mlTraces?.[chartMarket.symbol.toLowerCase()] ||
      poly.mlTraces?.[chartMarket.symbol.toLowerCase()])

  const setMode = async (mode) => {
    if (!mode || mode === displayMode || modeBusy) return
    setModeBusy(true)
    setModeOverride(mode)
    try {
      await setCfg({ mode }, { silent: true, toastMsg: mode === 'live' ? 'LIVE mode' : 'PAPER mode' })
      // Pull fresh mode-scoped state right away so numbers switch with the label,
      // instead of waiting up to a full poll for paper/live data to catch up.
      await refreshState?.()
    } catch {
      setModeOverride(null)
    } finally {
      setModeBusy(false)
    }
  }

  useEffect(() => {
    if (tab !== 'markets' && tab !== 'overview') return undefined
    let alive = true
    let n = 0
    const pull = () => {
      n += 1
      // every ~30s also nudge ML refresh via ?ml=1
      const qs = n === 1 || n % 15 === 0 ? '?ml=1' : ''
      fetch(`/api/poly/charts${qs}`)
        .then((r) => r.json())
        .then((d) => {
          if (alive && d?.charts) setChartPack(d)
        })
        .catch(() => {})
    }
    pull()
    const id = setInterval(pull, 2000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [tab])

  const go = (id) => {
    if (id === 'behavior' && isMobile) {
      setSettingsOpen(true)
      if (isMobile) setOpenMobile(false)
      return
    }
    setTab(id)
    if (isMobile) setOpenMobile(false)
  }

  return (
    <>
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
      <TradeApproveDialog
        pending={pending}
        busy={busy}
        onApprove={approve}
        onReject={(id) => act('/api/poly/reject', { id }, 'Trade skipped')}
      />

      <Sidebar collapsible="offcanvas" variant="sidebar" className="border-r border-sidebar-border">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <a href="/" className="gap-3 py-1">
                  <img src="/favicon.svg" alt="Zinger" className="size-9 shrink-0" />
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-bold tracking-[0.14em]">ZINGER</span>
                    <span className="text-muted-foreground truncate font-mono text-[0.65rem]">
                      5m terminal · <LiveClock />
                    </span>
                  </div>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {['ops', 'book', 'ops2'].map((groupKey) => {
            const groups = {
              ops: { label: 'Ops', ids: ['overview', 'markets', 'process', 'traces'] },
              book: { label: 'Book', ids: ['positions', 'account', 'history'] },
              ops2: { label: 'Control', ids: ['log', 'behavior'] },
            }
            const g = groups[groupKey]
            const items = navItems.filter((n) => g.ids.includes(n.id))
            if (!items.length) return null
            return (
              <SidebarGroup key={groupKey}>
                <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {items.map(({ id, label, description, icon: Icon }) => (
                      <SidebarMenuItem key={id}>
                        <SidebarMenuButton
                          isActive={tab === id}
                          tooltip={description || label}
                          onClick={() => go(id)}
                        >
                          <Icon />
                          <span>{label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )
          })}

          <SidebarSeparator />

          <SidebarGroup>
            <SidebarGroupLabel>Status</SidebarGroupLabel>
            <SidebarGroupContent className="flex flex-col gap-3 px-3 pb-2">
              <Badge
                className={cn(
                  'w-fit',
                  poly.running
                    ? 'border-[#a3e635]/40 bg-[#a3e635]/15 text-[#a3e635] hover:bg-[#a3e635]/20'
                    : '',
                )}
                variant={poly.running ? 'outline' : 'secondary'}
              >
                {poly.running ? 'ENGAGED' : 'Stopped'}
              </Badge>
              <ModeRail mode={displayMode} onChange={setMode} disabled={modeBusy} />
              {cfg.announceBeforeTrade !== false && (
                <Badge variant="outline" className="w-fit">
                  Announce
                </Badge>
              )}
              {pending.length > 0 && (
                <Badge variant="secondary" className="w-fit">
                  {pending.length} pending
                </Badge>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <div className="flex flex-col gap-2 px-2 pb-2">
            <div className="[&_button]:w-full">
              <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full font-mono text-[0.65rem]"
              onClick={() => logoutAuth()}
            >
              Sign out
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="poly-shell max-w-full overflow-x-hidden">
        <header className="bg-background/90 sticky top-0 z-30 border-b border-border/70 backdrop-blur-md">
          <div className="flex items-center gap-1.5 px-2 py-1.5 sm:gap-2 sm:px-3 sm:py-2">
            <SidebarTrigger className="size-9 shrink-0 sm:size-8" />
            <img src="/favicon.svg" alt="" className="hidden size-6 shrink-0 sm:block" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-bold tracking-[0.14em] text-primary">
                  ZINGER
                </span>
                <span className="text-muted-foreground truncate text-[0.6rem] font-medium sm:text-[0.65rem]">
                  / {navItems.find((n) => n.id === tab)?.label || 'Mission'}
                </span>
              </div>
              <div className="text-muted-foreground truncate font-mono text-[0.6rem] sm:text-[0.65rem]">
                <span className={livePnl >= 0 ? 'text-primary' : 'text-destructive'}>
                  net {money(livePnl)}
                </span>
                {' · '}
                eq {money(portfolio.equity ?? cash)}
                {' · '}
                cash {money(cash)}
                {' · '}
                open {portfolio.openCount ?? botPositions.length}
                {readiness.clobError ? ' · CLOB err' : ''}
                {' · '}
                <span className={displayMode === 'live' ? 'text-primary' : ''}>
                  {String(displayMode || 'paper').toUpperCase()}
                </span>
              </div>
            </div>
            <div className="hidden items-center gap-2 font-mono text-[0.65rem] md:flex">
              <div className="rounded border border-border/60 px-1.5 py-0.5">
                <span className="text-muted-foreground">cycle </span>
                <LiveCountdown
                  endAtMs={poly.cycle?.endAtMs}
                  fallbackMs={poly.cycle?.remainingMs}
                  fallbackSeconds={poly.cycle?.remainingSeconds}
                />
              </div>
              {poly.cycle?.class === 'SETTLED' || poly.cycle?.class === 'ENDING' ? (
                <div className="rounded border border-primary/40 px-1.5 py-0.5 text-primary">
                  {poly.cycle?.class}
                  {poly.cycleReward?.rewards != null ? ` +$${Number(poly.cycleReward.rewards).toFixed(2)}` : ''}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <div className="max-w-[7.5rem] shrink-0 sm:max-w-none [&_button]:h-8 [&_button]:max-w-full [&_button]:truncate [&_button]:text-xs">
                <ConnectButton
                  showBalance={false}
                  chainStatus="none"
                  accountStatus={{ smallScreen: 'avatar', largeScreen: 'address' }}
                />
              </div>
              <NotificationsPanel
                actions={poly.actions || poly.executionLog || []}
                notifications={poly.notifications || []}
                unread={poly.notificationsUnread || 0}
                pending={pending}
                open={notifOpen}
                onOpenChange={setNotifOpen}
                onMarkRead={() => {
                  fetch('/api/poly/notifications/read', { method: 'POST' }).catch(() => {})
                }}
              />
              <ModeRail mode={displayMode} onChange={setMode} disabled={modeBusy} />
              <Badge
                variant={isPaper ? 'secondary' : 'default'}
                className={cn(
                  'hidden sm:inline-flex font-bold tracking-wider',
                  isPaper ? '' : 'bg-amber-500/20 text-amber-400 border-amber-500/40',
                )}
              >
                {isPaper ? 'PAPER' : 'LIVE'}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  'hidden sm:inline-flex',
                  poly.running && 'border-[#a3e635]/40 bg-[#a3e635]/15 text-[#a3e635]',
                )}
              >
                {poly.stopRequest?.status === 'queued' ? 'STOP QUEUED' : poly.running ? 'ENGAGED' : 'STOPPED'}
              </Badge>
              <Badge variant="outline" className="hidden font-mono sm:inline-flex">
                SESSION {poly.session?.trades ?? 0}T · {money(poly.session?.pnl)}
              </Badge>
            </div>
          </div>

          {/* Live tick tape — flashes on every price update */}
          <LiveTickStrip poly={poly} />

          <div className="grid grid-cols-4 gap-1 border-t border-white/10 px-2 py-1 sm:flex sm:flex-wrap sm:gap-1.5 sm:px-3 sm:py-1.5">
            <Button
              size="sm"
              className="h-9 min-w-0 px-1.5 text-xs sm:h-8 sm:px-3 sm:text-sm"
              variant={poly.stopRequest?.status === 'queued' ? 'outline' : poly.running ? 'destructive' : 'default'}
              disabled={botBusy}
              onClick={toggleBot}
            >
              {poly.running ? <Square data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              <span className="truncate">
                {botBusy ? '…' : poly.stopRequest?.status === 'queued' ? 'Cancel stop' : poly.running ? 'Stop after window' : 'Start'}
              </span>
            </Button>

            <Button
              size="sm"
              className="h-9 min-w-0 px-1.5 text-xs sm:h-8 sm:px-3 sm:text-sm"
              variant="outline"
              disabled={syncing}
              onClick={sync}
            >
              <RefreshCw data-icon="inline-start" className={syncing ? 'animate-spin' : undefined} />
              Sync
            </Button>

            <Button
              size="sm"
              className="h-9 min-w-0 px-1.5 text-xs sm:h-8 sm:px-3 sm:text-sm"
              variant="destructive"
              onClick={() => act('/api/poly/sell-all', null, 'Panic sell sent')}
            >
              <Trash2 data-icon="inline-start" />
              Panic
            </Button>

            <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
              <SheetTrigger asChild>
                <Button
                  size="sm"
                  className="h-9 min-w-0 px-1.5 text-xs sm:h-8 sm:px-3 sm:text-sm"
                  variant="secondary"
                >
                  <Settings2 data-icon="inline-start" />
                  <span className="truncate">Beh</span>
                </Button>
              </SheetTrigger>
              <SheetContent className="w-full overflow-y-auto sm:max-w-md">
                <SheetHeader>
                  <SheetTitle>Bot behavior</SheetTitle>
                  <SheetDescription>Sizing, exits, and announce gate</SheetDescription>
                </SheetHeader>
                <div className="mt-3 px-1 pb-8">
                  <BehaviorForm
                    cfg={cfg}
                    profiles={poly.profiles}
                    onSave={setCfg}
                    configSessions={poly.configSessions || []}
                    onSaveSnapshot={saveConfigSnapshot}
                    onRestoreSnapshot={restoreConfigSnapshot}
                    onResetPaper={resetPaperData}
                    onResetLive={resetLiveData}
                  />
                </div>
              </SheetContent>
            </Sheet>
          </div>
          <TopNavTabs
            tab={tab}
            setTab={go}
            items={navItems.filter((n) => n.mobile !== false || n.id === 'behavior')}
            badges={navBadges}
            cycleLabel={cycleLabel}
          />
        </header>

        <div className="poly-mobile-pad scroll-anchor flex flex-1 flex-col gap-1.5 p-1.5 sm:gap-2 sm:p-2">
          {!liveOk && displayMode === 'live' && (
            <Alert variant="destructive">
              <AlertTitle>Live blocked</AlertTitle>
              <AlertDescription>
                {(readiness.needs || []).join(' · ') || 'Waiting for a fresh readiness tick from Core'}
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>API error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {tab === 'overview' && (
            <div className="poly-panel flex flex-col gap-2 sm:gap-3">
              <PageIntro
                title="Mission"
                description="Full pulse — model canvas, bot trades, live taps, cycle settle, and optimizer."
              />
              {audit.issues?.length > 0 && (
                <Alert>
                  <AlertTitle>Audit notes</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-snug">
                      {audit.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 sm:gap-2">
                <div className="data-tile">
                  <div className="lbl">{isPaper ? 'Paper equity' : 'Equity'}</div>
                  <div className="val text-primary">{money(portfolio.equity ?? cash)}</div>
                </div>
                <div className="data-tile">
                  <div className="lbl">Net</div>
                  <div className={cn('val', livePnl >= 0 ? 'text-primary' : 'text-destructive')}>{money(livePnl)}</div>
                </div>
                <div className="data-tile">
                  <div className="lbl">R / U</div>
                  <div className="val font-mono text-xs sm:text-sm">
                    {money(realizedPnl)} / {money(unrealizedPnl)}
                  </div>
                </div>
                <div className="data-tile">
                  <div className="lbl">Cycle</div>
                  <div className="val">
                    <LiveCountdown
                      endAtMs={poly.cycle?.endAtMs}
                      fallbackMs={poly.cycle?.remainingMs}
                      fallbackSeconds={poly.cycle?.remainingSeconds}
                    />
                    <span className="text-muted-foreground ml-1 text-[0.55rem]">{poly.cycle?.class}</span>
                  </div>
                </div>
              </div>
              <SystemFlow
                running={poly.running}
                mode={displayMode}
                mlAlive={Boolean(poly.mlTraces?.btc || poly.mlTraces?.eth || poly.intelligence?.btc || poly.intelligence?.eth)}
                lastScan={poly.lastScan?.time || poly.lastScan}
                models={poly.models || []}
              />
              <MlBay
                mlTraces={poly.mlTraces || chartPack.mlTraces || {}}
                intelligence={poly.intelligence || {}}
                confidenceBuffer={poly.confidenceBuffer || {}}
                models={poly.models || []}
              />
              <div className="grid gap-2 lg:grid-cols-2">
                <Card>
                  <CardHeader className="px-3 py-2">
                    <CardTitle className="text-base">Bot trades</CardTitle>
                    <CardDescription>Latest closes in {String(displayMode || 'paper').toUpperCase()}</CardDescription>
                  </CardHeader>
                  <CardContent className="px-0 pb-2">
                    <ScrollArea className="h-[180px]">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Sym</TableHead>
                            <TableHead>Exit</TableHead>
                            <TableHead className="text-right">PnL</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(poly.trades || []).slice(0, 12).map((t) => (
                            <TableRow key={t.id || `${t.slug}-${t.timestamp}`}>
                              <TableCell className="font-mono text-xs">
                                {t.symbol} {String(t.outcome || '').toUpperCase()}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">{t.exitReason || '—'}</TableCell>
                              <TableCell className={cn('text-right font-mono text-xs', (t.pnl || 0) >= 0 ? 'text-primary' : 'text-destructive')}>
                                {money(t.pnl)}
                              </TableCell>
                            </TableRow>
                          ))}
                          {!(poly.trades || []).length && (
                            <TableRow>
                              <TableCell colSpan={3} className="text-muted-foreground text-center text-xs">No trades yet</TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="px-3 py-2">
                    <CardTitle className="text-base">Live taps</CardTitle>
                    <CardDescription>Execution feed · last scans</CardDescription>
                  </CardHeader>
                  <CardContent className="px-3 pb-3">
                    <ScrollArea className="h-[180px]">
                      <ul className="space-y-1.5 font-mono text-[0.65rem]">
                        {(poly.executionLog || []).slice(0, 16).map((e, i) => (
                          <li key={e.id || i} className="border-b border-border/40 pb-1 leading-snug">
                            <span className="text-muted-foreground">{fmtTimeMs(e.time || e.ts)}</span>{' '}
                            <span className="text-foreground">{e.msg || e.message || e.type}</span>
                          </li>
                        ))}
                        {!(poly.executionLog || []).length && (
                          <li className="text-muted-foreground">Waiting for taps…</li>
                        )}
                      </ul>
                    </ScrollArea>
                  </CardContent>
                </Card>
              </div>
              <div className="grid gap-2 lg:grid-cols-2">
                <Card>
                  <CardHeader className="px-3 py-2">
                    <CardTitle className="text-base">Cycle settle</CardTitle>
                    <CardDescription>Rewards booked when the 5m window closes</CardDescription>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-2 px-3 pb-3 text-sm">
                    <div>
                      <div className="text-muted-foreground text-xs">Last cycle PnL</div>
                      <div className="font-mono">{money(poly.settle?.lastCycle?.pnl ?? poly.cycleReward?.pnl)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Rewards</div>
                      <div className="font-mono text-primary">{money(poly.settle?.lastCycle?.rewards ?? poly.cycleReward?.rewards)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Settles</div>
                      <div className="font-mono">{poly.settle?.lastCycle?.closes ?? poly.cycleReward?.closes ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Class</div>
                      <div className="font-mono">{poly.cycle?.class || '—'}</div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex-row items-center justify-between gap-2 px-3 py-2">
                    <div>
                      <CardTitle className="text-base">Optimizer</CardTitle>
                      <CardDescription>LLM + heuristic Kelly / SL / partials</CardDescription>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={async () => {
                        try {
                          const r = await fetch('/api/poly/optimize', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ apply: true, useLlm: true }),
                          })
                          const d = await r.json()
                          toast.success(d.applied ? 'Config tuned' : (d.reasons?.[0] || 'Optimizer ran'))
                        } catch (e) {
                          toast.error(e.message || 'Optimize failed')
                        }
                      }}
                    >
                      Run
                    </Button>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 text-xs font-mono space-y-1">
                    <div className="text-muted-foreground">
                      last {poly.optimizer?.lastApplyAt ? new Date(poly.optimizer.lastApplyAt).toLocaleTimeString() : '—'}
                    </div>
                    <div className="truncate">
                      {(poly.optimizer?.lastResult?.reasons || []).slice(0, 2).join(' · ') || 'Waiting for closed trades…'}
                    </div>
                    <div className="text-muted-foreground truncate">
                      patch {Object.keys(poly.optimizer?.lastResult?.patch || {}).join(', ') || '—'}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex-row items-center justify-between gap-2 px-3 py-2">
                    <div>
                      <CardTitle className="text-base">Regime governor</CardTitle>
                      <CardDescription>Auto-switches scalp / trend-ride / arb-only</CardDescription>
                    </div>
                    <span
                      className={cn(
                        'rounded px-2 py-0.5 text-xs font-mono uppercase',
                        poly.governor?.breakerActive
                          ? 'bg-destructive/20 text-destructive'
                          : 'bg-primary/15 text-primary',
                      )}
                    >
                      {poly.governor?.breakerActive ? 'BREAKER' : (poly.governor?.profile || '—')}
                    </span>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 text-xs font-mono space-y-1">
                    <div className="text-muted-foreground">
                      {poly.governor?.enabled === false ? 'disabled' : 'live'}
                      {' · '}last {poly.governor?.lastSwitchAt ? new Date(poly.governor.lastSwitchAt).toLocaleTimeString() : '—'}
                      {poly.governor?.lastResult?.source ? ` · ${poly.governor.lastResult.source}` : ''}
                    </div>
                    <div className="truncate">
                      {(poly.governor?.lastResult?.reasons || []).slice(0, 2).join(' · ') || 'Watching regime…'}
                    </div>
                    <div className="text-muted-foreground truncate">
                      {(poly.governor?.history || []).slice(0, 3).map((h) => `${h.action === 'switch' ? '→' : h.action === 'revert' ? '↩' : h.action === 'breaker' ? '⛔' : '·'}${h.regime}`).join('  ') || 'no switches yet'}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="px-3 py-2">
                    <CardTitle className="text-base">Regime win rate</CardTitle>
                    <CardDescription>Which profile actually wins — {String(displayMode || 'paper').toUpperCase()}</CardDescription>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 text-xs font-mono space-y-1.5">
                    {(poly.governor?.profiles || []).map((name) => {
                      const row = poly.governor?.profilePerf?.[name] || { trades: 0, winRate: 0 }
                      const active = poly.governor?.profile === name
                      return (
                        <div key={name} className="flex items-center gap-2">
                          <span className={cn('w-20 shrink-0', active && 'text-primary font-semibold')}>{name}</span>
                          <div className="relative h-3 flex-1 overflow-hidden rounded bg-muted/40">
                            <div
                              className={cn('absolute inset-y-0 left-0', row.winRate >= 50 ? 'bg-primary/60' : 'bg-destructive/50')}
                              style={{ width: `${Math.min(100, row.winRate)}%` }}
                            />
                          </div>
                          <span className="w-24 shrink-0 text-right text-muted-foreground">
                            {row.trades ? `${row.winRate}% · ${row.trades}t` : '— no trades'}
                          </span>
                        </div>
                      )
                    })}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="px-3 py-2">
                    <CardTitle className="text-base">Regime PnL</CardTitle>
                    <CardDescription>Net profit attributed to each regime</CardDescription>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 text-sm space-y-1">
                    {(poly.governor?.profiles || []).map((name) => {
                      const row = poly.governor?.profilePerf?.[name] || { pnl: 0, trades: 0 }
                      const active = poly.governor?.profile === name
                      return (
                        <div key={name} className="flex items-center justify-between gap-2">
                          <span className={cn('font-mono text-xs', active && 'text-primary font-semibold')}>{name}</span>
                          <span className={cn('font-mono', (row.pnl || 0) >= 0 ? 'text-primary' : 'text-destructive')}>
                            {money(row.pnl)}
                          </span>
                        </div>
                      )
                    })}
                    {(() => {
                      const perf = poly.governor?.profilePerf || {}
                      const total = Object.values(perf).reduce((s, r) => s + Number(r?.pnl || 0), 0)
                      const unattr = perf.unattributed?.pnl || 0
                      return (
                        <>
                          <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/60 pt-1.5">
                            <span className="font-mono text-xs text-muted-foreground">attributed total</span>
                            <span className={cn('font-mono font-semibold', total >= 0 ? 'text-primary' : 'text-destructive')}>{money(total)}</span>
                          </div>
                          {perf.unattributed?.trades ? (
                            <div className="text-muted-foreground text-[0.65rem]">
                              incl. {money(unattr)} from {perf.unattributed.trades} pre-governor trade(s)
                            </div>
                          ) : null}
                        </>
                      )
                    })()}
                  </CardContent>
                </Card>
              </div>
              <div className="grid gap-2 sm:gap-3 lg:grid-cols-1">
                <Card>
                  <CardHeader className="px-3 py-2">
                    <CardTitle className="text-base">{isPaper ? 'Paper Account' : 'Account'}</CardTitle>
                    <CardDescription>{isPaper ? 'Virtual bankroll · separate from live' : 'Wallet + audit'}</CardDescription>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-2 px-3 pb-3 text-sm">
                    {isPaper ? (
                      <>
                        <div>
                          <div className="text-muted-foreground text-xs">Paper Bankroll</div>
                          <div className="font-mono text-primary text-base">{money(paperBankroll ?? 100)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Initial Deposit</div>
                          <div className="font-mono">{money(portfolio.paperInitialDeposit ?? 100)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Paper PnL</div>
                          <div className={cn('font-mono', (livePnl || 0) >= 0 ? 'text-primary' : 'text-destructive')}>{money(livePnl)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-xs">Equity</div>
                          <div className="font-mono">{money(portfolio.equity)}</div>
                        </div>
                        <div className="col-span-2 flex gap-2 pt-1">
                          <form className="flex gap-2 flex-1" onSubmit={async (e) => {
                            e.preventDefault();
                            const val = Number(e.target.amount.value);
                            if (!val || val <= 0) return;
                            await fetch('/api/poly/paper-deposit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({amount: val}) });
                            toast.success(`Deposited $${val.toFixed(2)} to paper`);
                            e.target.amount.value = '';
                          }}>
                            <Input name="amount" type="number" step="10" min="1" placeholder="Deposit $" className="h-10 flex-1" />
                            <Button type="submit" size="sm" className="h-10">Deposit</Button>
                          </form>
                          <form className="flex gap-2 flex-1" onSubmit={async (e) => {
                            e.preventDefault();
                            const val = Number(e.target.amount.value);
                            if (!val || val <= 0) return;
                            const r = await fetch('/api/poly/paper-withdraw', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({amount: val}) });
                            const d = await r.json();
                            if (d.ok) toast.success(`Withdrew $${val.toFixed(2)} from paper`);
                            else toast.error('Withdraw failed');
                            e.target.amount.value = '';
                          }}>
                            <Input name="amount" type="number" step="10" min="1" placeholder="Withdraw $" className="h-10 flex-1" />
                            <Button type="submit" size="sm" variant="outline" className="h-10">Withdraw</Button>
                          </form>
                        </div>
                        <div className="col-span-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                          <span className="text-muted-foreground text-xs">Wipe paper trades, positions &amp; PnL back to a clean session</span>
                          <Button type="button" size="sm" variant="destructive" className="h-9 shrink-0" onClick={resetPaperData}>
                            <RotateCcw data-icon="inline-start" />
                            Reset paper session
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                    <div>
                      <div className="text-muted-foreground text-xs">Deposit</div>
                      <div className="font-mono text-xs sm:text-sm">{addr(readiness.depositWallet)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Spendable</div>
                      <div className="font-mono text-primary">{money(cash)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">CLOB</div>
                      <div className="font-mono">{money(readiness.clobBalance)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Deposit pUSD</div>
                      <div className="font-mono">{money(readiness.depositPusd)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Baseline</div>
                      <div className="font-mono">{money(portfolio.baselineUsd ?? cash)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">API</div>
                      <div className={readiness.apiReady ? 'text-primary' : 'text-destructive'}>
                        {readiness.apiReady ? 'ok' : 'no'}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Owner</div>
                      <div>{readiness.ownerMatches === false ? 'mismatch' : 'ok'}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Scans</div>
                      <div className="font-mono">{poly.stats?.scansDone || 0}</div>
                    </div>
                    <div className="col-span-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                      <span className="text-muted-foreground text-xs">
                        Wipe phantom live trades &amp; re-baseline to current CLOB cash
                      </span>
                      <Button type="button" size="sm" variant="destructive" className="h-9 shrink-0" onClick={resetLiveData}>
                        <RotateCcw data-icon="inline-start" />
                        Normalize live
                      </Button>
                    </div>
                      </>
                    )}
                  </CardContent>
                </Card>

              </div>
              <Card>
                <CardHeader className="flex-col items-start gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="text-base">Live markets</CardTitle>
                    <CardDescription>
                      {liveMarkets.length} active · TP {cfg.tpPctLow}–{cfg.tpPctHigh}% · SL {cfg.slPct}%
                    </CardDescription>
                  </div>
                  <Button size="sm" variant="outline" className="h-9 w-full sm:w-auto" onClick={() => go('markets')}>
                    Open markets
                  </Button>
                </CardHeader>
                <CardContent className="px-0 pb-2">
                  <MarketTable markets={liveMarkets.slice(0, 6)} compact />
                </CardContent>
              </Card>
            </div>
          )}

          {tab === 'markets' && (
            <div className="poly-panel flex flex-col gap-2 lg:grid lg:grid-cols-[1.35fr_1fr]">
              <div className="lg:col-span-2">
                <PageIntro
                  title="Markets"
                  description="Current BTC/ETH 5-minute windows — tap a row for chart and order-book depth."
                />
              </div>
              <Card>
                <CardHeader className="px-3 py-2">
                  <CardTitle className="text-base">Current 5-min windows</CardTitle>
                  <CardDescription>Tap a row for chart + order-book depth</CardDescription>
                </CardHeader>
                <CardContent className="px-0 pb-2">
                  <MarketTable
                    markets={liveMarkets}
                    onSelectBook={(m) => setBookMarket(m)}
                    selectedSlug={activeBook?.slug}
                  />
                </CardContent>
              </Card>
              <SpotChart />
              <div className="flex flex-col gap-3">
                <ChartPanel market={chartMarket} ticks={chartTicks} mlTrace={chartMl} />
                {activeBook?.tokenIds ? (
                  <OrderBook
                    tokenIds={activeBook.tokenIds}
                    tokenId={activeBook.tokenIds?.up || activeBook.tokenIds?.down}
                    label={bookLabel}
                    initialDepth={marketBook(activeBook)}
                    onClose={bookMarket ? () => setBookMarket(null) : undefined}
                  />
                ) : (
                  <Card>
                    <CardContent className="text-muted-foreground py-10 text-center text-sm">
                      Select a market to load depth
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          )}

          {tab === 'positions' && (
            <div className="poly-panel poly-page flex flex-col gap-2">
              <PageIntro
                title="Positions"
                description="Live mark, entry, bid/ask, and unrealized PnL for wallet + bot fills."
              />
            <Card>
              <CardHeader className="px-3 py-2">
                <CardTitle className="text-base">Positions</CardTitle>
                <CardDescription>
                  {botPositions.length} bot · {openPositions.length} wallet · uPnL {money(unrealizedPnl)}
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0 pb-2">
                {openPositions.length === 0 && botPositions.length === 0 ? (
                  <Empty className="border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Wallet />
                      </EmptyMedia>
                      <EmptyTitle>No open positions</EmptyTitle>
                      <EmptyDescription>Cash sits until the next fill.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <>
                    <div className="flex flex-col gap-2 p-2 lg:hidden">
                      {[
                        ...botPositions.map((p) => ({ kind: 'bot', key: p.id, p })),
                        ...openPositions.map((p, i) => ({ kind: 'wallet', key: `w-${i}`, p })),
                      ].map(({ kind, key, p }) => {
                        const pnl = kind === 'wallet' ? p.cashPnl : (p.unrealizedPnl ?? p.pnl)
                        const mark = p.liveMark ?? p.currentPrice ?? p.avgPrice
                        const entry = p.entryPrice ?? p.avgPrice
                        return (
                        <div key={key} className="rounded-lg border border-border/70 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <Badge variant="outline" className="mb-1">{kind}</Badge>
                              <div className="text-sm font-medium">
                                {kind === 'wallet' ? (p.title || p.slug || '').slice(0, 40) : p.symbol}
                              </div>
                              <div className="text-muted-foreground font-mono text-[0.65rem]">
                                {(kind === 'wallet' ? p.outcome : p.outcome?.toUpperCase()) || '—'}
                                {entry != null && mark != null && (
                                  <> · {Number(entry).toFixed(3)}→{Number(mark).toFixed(3)}</>
                                )}
                                {p.gainPct != null && <> · {Number(p.gainPct).toFixed(1)}%</>}
                              </div>
                              {(p.bestBid != null || p.bestAsk != null) && (
                                <div className="text-muted-foreground font-mono text-[0.6rem]">
                                  bid {p.bestBid?.toFixed?.(3) ?? '—'} / ask {p.bestAsk?.toFixed?.(3) ?? '—'}
                                </div>
                              )}
                            </div>
                            <div className={cn('font-mono text-sm', Number(pnl || 0) >= 0 ? 'text-primary' : 'text-destructive')}>
                              {money(pnl)}
                            </div>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="font-mono text-xs text-muted-foreground">
                              size {kind === 'wallet' ? p.size : (p.shares || 0).toFixed(2)} ·{' '}
                              {money(kind === 'wallet' ? p.currentValue : p.markValue)}
                            </span>
                            {kind === 'wallet' && p.asset && Number(p.size) > 0 && (
                              <Button size="sm" className="h-8" variant="destructive"
                                onClick={() => act('/api/poly/sell-pm', { assetId: p.asset, size: p.size }, 'Sold')}>
                                Dump
                              </Button>
                            )}
                            {kind === 'bot' && (
                              <Button size="sm" className="h-8" variant="destructive"
                                onClick={() => act('/api/poly/sell', { positionId: p.id }, 'Sold')}>
                                Sell
                              </Button>
                            )}
                          </div>
                        </div>
                        )
                      })}
                    </div>

                    <div className="hidden lg:block">
                      <ScrollArea className="h-[min(60vh,420px)]">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Src</TableHead>
                              <TableHead>Market</TableHead>
                              <TableHead>Side</TableHead>
                              <TableHead>Entry</TableHead>
                              <TableHead>Mark</TableHead>
                              <TableHead>Bid/Ask</TableHead>
                              <TableHead>Size</TableHead>
                              <TableHead>PnL</TableHead>
                              <TableHead />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {botPositions.map((p) => (
                              <TableRow key={p.id}>
                                <TableCell>bot</TableCell>
                                <TableCell>{p.symbol}</TableCell>
                                <TableCell>{p.outcome?.toUpperCase()}</TableCell>
                                <TableCell className="font-mono">{Number(p.entryPrice || 0).toFixed(3)}</TableCell>
                                <TableCell className="font-mono">{Number((p.liveMark ?? p.currentPrice) || 0).toFixed(3)}</TableCell>
                                <TableCell className="font-mono text-[0.7rem]">
                                  {p.bestBid?.toFixed?.(3) ?? '—'}/{p.bestAsk?.toFixed?.(3) ?? '—'}
                                </TableCell>
                                <TableCell className="font-mono">{(p.shares || 0).toFixed(2)}</TableCell>
                                <TableCell className={cn('font-mono', ((p.unrealizedPnl ?? p.pnl) || 0) >= 0 ? 'text-primary' : 'text-destructive')}>
                                  {money(p.unrealizedPnl ?? p.pnl)}
                                  {p.gainPct != null && (
                                    <span className="text-muted-foreground ml-1 text-[0.65rem]">
                                      {Number(p.gainPct).toFixed(1)}%
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Button size="xs" variant="destructive" onClick={() => act('/api/poly/sell', { positionId: p.id }, 'Sold')}>
                                    Sell
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                            {openPositions.map((p, i) => (
                              <TableRow key={`pm-${i}`}>
                                <TableCell>wallet</TableCell>
                                <TableCell>{(p.title || p.slug || '').slice(0, 36)}</TableCell>
                                <TableCell>{p.outcome}</TableCell>
                                <TableCell className="font-mono">{Number(p.avgPrice || p.entryPrice || 0).toFixed(3)}</TableCell>
                                <TableCell className="font-mono">{Number(p.curPrice || p.currentPrice || 0).toFixed(3)}</TableCell>
                                <TableCell className="font-mono">—</TableCell>
                                <TableCell className="font-mono">{p.size}</TableCell>
                                <TableCell className={cn('font-mono', (p.cashPnl || 0) >= 0 ? 'text-primary' : 'text-destructive')}>
                                  {money(p.cashPnl)}
                                </TableCell>
                                <TableCell>
                                  {p.asset && Number(p.size) > 0 && (
                                    <Button size="xs" variant="destructive"
                                      onClick={() => act('/api/poly/sell-pm', { assetId: p.asset, size: p.size }, 'Sold')}>
                                      Dump
                                    </Button>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </ScrollArea>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
            </div>
          )}

          {tab === 'account' && (
            <div className="poly-panel flex flex-col gap-2">
              <PageIntro
                title="Account"
                description="USD equity, session snapshot, best trades, and live audit — tape + NLP live in the header strip."
              />
              <AccountPage
                poly={poly}
                busy={busy}
                onSyncBaseline={async () => {
                  const cash = Number(poly?.cashAudit?.cash ?? poly?.portfolio?.cash ?? 0)
                  await act('/api/poly/baseline', { balanceUsd: cash }, `Baseline rebased to $${cash.toFixed(2)}`)
                  if (refreshState) refreshState()
                }}
              />
            </div>
          )}

          {tab === 'history' && (
            <div className="poly-panel flex flex-col gap-2">
              <PageIntro
                title="History"
                description={`${String(displayMode || 'paper').toUpperCase()} book — live cash audit + window stats (open→end).`}
              />
              {(() => {
                const trades = (poly.trades || []).filter((t) => !t.mode || t.mode === (displayMode || 'paper'))
                const wins = trades.filter((t) => (t.pnl || 0) > 0)
                const losses = trades.filter((t) => (t.pnl || 0) <= 0)
                const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0)
                const best = trades.reduce((b, t) => ((t.pnl || 0) > (b?.pnl || -Infinity) ? t : b), null)
                const worst = trades.reduce((b, t) => ((t.pnl || 0) < (b?.pnl || Infinity) ? t : b), null)
                const wr = trades.length ? (wins.length / trades.length) * 100 : 0
                const ca = poly.cashAudit || {}
                const win = poly.windows?.current || {}
                const remSec = Math.max(0, Math.ceil((win.remainingMs || poly.cycle?.remainingMs || 0) / 1000))
                return (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-2.5">
                      <Kpi label="Cash" value={money(ca.cash ?? cash)} tone="muted" />
                      <Kpi
                        label="Unrealized"
                        value={money(ca.unrealizedPnl ?? unrealizedPnl)}
                        tone={(ca.unrealizedPnl ?? unrealizedPnl) >= 0 ? 'up' : 'down'}
                      />
                      <Kpi
                        label="Realized"
                        value={money(ca.realizedPnl ?? realizedPnl)}
                        tone={(ca.realizedPnl ?? realizedPnl) >= 0 ? 'up' : 'down'}
                      />
                      <Kpi
                        label="Net PnL"
                        value={money(ca.netPnl ?? livePnl)}
                        tone={(ca.netPnl ?? livePnl) >= 0 ? 'up' : 'down'}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-2.5">
                      <Kpi label="Equity" value={money(ca.equity ?? portfolio.equity ?? cash)} />
                      <Kpi label="Open marks" value={money(ca.openMarkValue ?? portfolio.openMarkValue)} />
                      <Kpi label="Window closes" value={`${win.closes ?? 0} · TP ${win.tpHits ?? 0}`} />
                      <Kpi
                        label="Window left"
                        value={`${Math.floor(remSec / 60)}:${String(remSec % 60).padStart(2, '0')}`}
                        tone={remSec <= 30 ? 'down' : 'muted'}
                      />
                    </div>
                    <Card className={cn(!ca.ok && 'border-destructive/40')}>
                      <CardHeader className="px-3 py-2">
                        <CardTitle className="text-base">Live cash audit</CardTitle>
                        <CardDescription>
                          {String(displayMode || 'paper').toUpperCase()} · source {ca.pnlSource || '—'} ·{' '}
                          {ca.ok ? 'books clean' : `${(ca.issues || []).length} issue(s)`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="grid grid-cols-2 gap-2 px-3 pb-3 font-mono text-xs sm:grid-cols-4">
                        <div>
                          <div className="text-muted-foreground text-[0.6rem] uppercase">Cash</div>
                          <div>{money(ca.cash ?? cash)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-[0.6rem] uppercase">Unrealized</div>
                          <div className={(ca.unrealizedPnl ?? 0) >= 0 ? 'text-primary' : 'text-destructive'}>
                            {money(ca.unrealizedPnl ?? unrealizedPnl)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-[0.6rem] uppercase">Realized</div>
                          <div className={(ca.realizedPnl ?? 0) >= 0 ? 'text-primary' : 'text-destructive'}>
                            {money(ca.realizedPnl ?? realizedPnl)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground text-[0.6rem] uppercase">Net</div>
                          <div className={(ca.netPnl ?? 0) >= 0 ? 'text-primary' : 'text-destructive'}>
                            {money(ca.netPnl ?? livePnl)}
                          </div>
                        </div>
                        {(ca.issues || []).length > 0 && (
                          <div className="col-span-2 text-destructive sm:col-span-4">
                            {(ca.issues || []).slice(0, 4).map((iss, i) => (
                              <div key={i}>! {iss}</div>
                            ))}
                          </div>
                        )}
                        {(ca.notes || []).length > 0 && (
                          <div className="text-amber-400/90 col-span-2 sm:col-span-4">
                            {(ca.notes || []).slice(0, 4).map((n, i) => (
                              <div key={i}>· {n}</div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader className="px-3 py-2">
                        <CardTitle className="text-base">Current window</CardTitle>
                        <CardDescription>
                          Open {win.startAtMs ? new Date(win.startAtMs).toLocaleTimeString() : '—'}
                          {' → '}
                          End {win.endAtMs ? new Date(win.endAtMs).toLocaleTimeString() : '—'}
                          {' · '}PnL {money(win.pnl)} · WR {win.wr ?? 0}%
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="grid grid-cols-3 gap-2 px-3 pb-3 font-mono text-xs sm:grid-cols-6">
                        <div><span className="text-muted-foreground">closes</span> {win.closes ?? 0}</div>
                        <div><span className="text-muted-foreground">opens</span> {win.opens ?? 0}</div>
                        <div><span className="text-muted-foreground">TP</span> {win.tpFull ?? 0}/{win.tpPartial ?? 0}</div>
                        <div><span className="text-muted-foreground">SL</span> {win.byReason?.sl ?? 0}</div>
                        <div><span className="text-muted-foreground">trail</span> {win.byReason?.trail ?? 0}</div>
                        <div><span className="text-muted-foreground">settle</span> {win.byReason?.settle ?? 0}</div>
                      </CardContent>
                    </Card>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-2.5">
                      <Kpi label="Closed (mode)" value={String(trades.length)} />
                      <Kpi
                        label="Trade PnL"
                        value={money(totalPnl)}
                        tone={totalPnl >= 0 ? 'up' : 'down'}
                      />
                      <Kpi label="Win rate" value={`${wr.toFixed(0)}%`} tone={wr >= 50 ? 'up' : 'down'} />
                      <Kpi
                        label="Mode"
                        value={String(displayMode || 'paper').toUpperCase()}
                        tone={displayMode === 'live' ? 'up' : 'muted'}
                      />
                    </div>
                    {(best || worst) && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {best && (
                          <Card className="border-[#a3e635]/25 bg-[#a3e635]/5">
                            <CardHeader className="px-3 py-2">
                              <CardDescription>Best close</CardDescription>
                              <CardTitle className="font-mono text-lg text-[#a3e635]">
                                +${Math.abs(Number(best.pnl || 0)).toFixed(2)}
                              </CardTitle>
                            </CardHeader>
                            <CardContent className="text-muted-foreground px-3 pb-3 text-xs">
                              {best.symbol} {best.outcome?.toUpperCase()} · {best.exitReason?.toUpperCase()} ·{' '}
                              {best.mode}
                            </CardContent>
                          </Card>
                        )}
                        {worst && (
                          <Card className="border-destructive/25 bg-destructive/5">
                            <CardHeader className="px-3 py-2">
                              <CardDescription>Worst close</CardDescription>
                              <CardTitle className="text-destructive font-mono text-lg">
                                {money(worst.pnl)}
                              </CardTitle>
                            </CardHeader>
                            <CardContent className="text-muted-foreground px-3 pb-3 text-xs">
                              {worst.symbol} {worst.outcome?.toUpperCase()} · {worst.exitReason?.toUpperCase()} ·{' '}
                              {worst.mode}
                            </CardContent>
                          </Card>
                        )}
                      </div>
                    )}
                    <Card>
                      <CardHeader className="px-3 py-2">
                        <CardTitle className="text-base">Trade detail</CardTitle>
                        <CardDescription>
                          {wins.length}W / {losses.length}L · newest first
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-2 px-3 pb-3">
                        {trades.length === 0 ? (
                          <Empty className="border-0">
                            <EmptyHeader>
                              <EmptyMedia variant="icon">
                                <History />
                              </EmptyMedia>
                              <EmptyTitle>No closed trades yet</EmptyTitle>
                              <EmptyDescription>
                                TP / SL / trail / panic closes land here with full detail.
                              </EmptyDescription>
                            </EmptyHeader>
                          </Empty>
                        ) : (
                          trades.slice(0, 40).map((t, i) => (
                            <div
                              key={i}
                              className="rounded-lg border border-border/70 p-2.5 sm:p-3"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      t.mode === 'live' &&
                                        'border-[#a3e635]/40 bg-[#a3e635]/15 text-[#a3e635]',
                                    )}
                                  >
                                    {t.mode}
                                  </Badge>
                                  <span className="font-semibold">
                                    {t.symbol} {t.outcome?.toUpperCase()}
                                  </span>
                                  <Badge variant="secondary">{t.exitReason?.toUpperCase() || '—'}</Badge>
                                </div>
                                <span
                                  className={cn(
                                    'font-mono text-sm font-semibold',
                                    (t.pnl || 0) >= 0 ? 'text-[#a3e635]' : 'text-destructive',
                                  )}
                                >
                                  {(t.pnl || 0) >= 0 ? '+' : ''}
                                  {money(t.pnl)}
                                </span>
                              </div>
                              <div className="text-muted-foreground mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[0.65rem] sm:grid-cols-4">
                                <span>Entry {money(t.entryPrice, 3)}</span>
                                <span>Exit {money(t.exitPrice, 3)}</span>
                                <span>Cost {money(t.costBasis)}</span>
                                <span>
                                  {(t.gainPct != null ? `${t.gainPct >= 0 ? '+' : ''}${Number(t.gainPct).toFixed(1)}%` : '—')}
                                </span>
                              </div>
                              <div className="text-muted-foreground mt-1 flex flex-wrap gap-2 text-[0.65rem]">
                                <span>{historyTime(t.timestamp || t.entryTime)}</span>
                                {t.slug && <span className="font-mono opacity-70">{t.slug}</span>}
                                {t.shares != null && <span>{Number(t.shares).toFixed(2)} sh</span>}
                              </div>
                            </div>
                          ))
                        )}
                      </CardContent>
                    </Card>
                  </>
                )
              })()}
            </div>
          )}

          {tab === 'log' && (
            <div className="poly-panel poly-page flex flex-col gap-2">
              <PageIntro
                title="Feed"
                description="Action log, execution stream, and operator AI chat against live bot state."
              />
              <ChatPanel
                actions={poly.actions || poly.executionLog || []}
                trades={poly.trades || []}
                positions={[...(poly.botPositions || []), ...(poly.positions || [])]}
                signals={poly.signals || poly.intelligence || {}}
                poly={poly}
              />
            </div>
          )}

          {tab === 'process' && <ProcessPage poly={poly} />}

          {tab === 'traces' && (
            <div className="poly-panel flex flex-col gap-2 sm:gap-3">
              <PageIntro
                title="Traces"
                description="Live decision, arb, and exit traces from the bot API — confidence-scaled TP/SL stamped on fills."
              />
              <div className="grid gap-2 lg:grid-cols-2">
                <Card>
                  <CardHeader className="px-3 py-2">
                    <CardTitle className="text-base">Decisions</CardTitle>
                    <CardDescription>Buy / arb / announce scoring</CardDescription>
                  </CardHeader>
                  <CardContent className="px-0 pb-2">
                    <ScrollArea className="h-[280px]">
                      <ul className="space-y-1.5 px-3 font-mono text-[0.65rem]">
                        {(poly.traces?.decisions || []).slice(0, 40).map((tr) => (
                          <li key={tr.id} className="border-b border-border/40 pb-1.5 leading-snug">
                            <span className="text-muted-foreground">{fmtTimeMs(tr.t)}</span>{' '}
                            <span className="text-primary">{tr.action || tr.kind}</span>{' '}
                            {tr.symbol} {String(tr.outcome || '').toUpperCase()}
                            {tr.confidence != null && ` · conf ${(Number(tr.confidence) * 100).toFixed(0)}%`}
                            {tr.score != null && ` · score ${Number(tr.score).toFixed(1)}`}
                            {tr.reasons?.length ? (
                              <div className="text-muted-foreground truncate">{tr.reasons.slice(0, 3).join(' · ')}</div>
                            ) : null}
                          </li>
                        ))}
                        {!(poly.traces?.decisions || []).length && (
                          <li className="text-muted-foreground py-6 text-center">No decision traces yet</li>
                        )}
                      </ul>
                    </ScrollArea>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="px-3 py-2">
                    <CardTitle className="text-base">Exits + events</CardTitle>
                    <CardDescription>SL / TP / settle / system</CardDescription>
                  </CardHeader>
                  <CardContent className="px-0 pb-2">
                    <ScrollArea className="h-[280px]">
                      <ul className="space-y-1.5 px-3 font-mono text-[0.65rem]">
                        {(poly.traces?.exits || poly.traces?.events || []).slice(0, 40).map((tr) => (
                          <li key={tr.id} className="border-b border-border/40 pb-1.5 leading-snug">
                            <span className="text-muted-foreground">{fmtTimeMs(tr.t)}</span>{' '}
                            <span className={cn(
                              tr.kind === 'sl' || tr.type === 'sl' ? 'text-destructive' : 'text-primary',
                            )}>
                              {tr.kind || tr.type}
                            </span>{' '}
                            {tr.msg || `${tr.symbol || ''} ${tr.outcome || ''}`}
                            {tr.pnl != null && ` · ${money(tr.pnl)}`}
                          </li>
                        ))}
                        {!(poly.traces?.exits || []).length && !(poly.traces?.events || []).length && (
                          <li className="text-muted-foreground py-6 text-center">No exit traces yet</li>
                        )}
                      </ul>
                    </ScrollArea>
                  </CardContent>
                </Card>
              </div>
              <Card>
                <CardHeader className="flex-row items-center justify-between px-3 py-2">
                  <div>
                    <CardTitle className="text-base">API</CardTitle>
                    <CardDescription>GET /api/poly/traces · lean SSE includes recent slice</CardDescription>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={async () => {
                      const r = await fetch('/api/poly/traces?limit=40')
                      const d = await r.json()
                      toast.message(`Traces ${d.events?.length || 0} events · unread ${d.unread || 0}`)
                    }}
                  >
                    Refresh API
                  </Button>
                </CardHeader>
              </Card>
            </div>
          )}

          {tab === 'behavior' && (
            <div className="poly-panel flex flex-col gap-2">
              <PageIntro
                title="Behavior"
                description="Sizing, exits, announce gate, and Kelly controls. Same form as the Behavior sheet."
              />
              <Card>
                <CardHeader className="px-3 py-2">
                  <CardTitle className="text-base">Bot behavior</CardTitle>
                  <CardDescription>Changes apply immediately after save</CardDescription>
                </CardHeader>
                <CardContent className="px-3 pb-3">
                  <BehaviorForm
                    cfg={cfg}
                    profiles={poly.profiles}
                    onSave={setCfg}
                    configSessions={poly.configSessions || []}
                    onSaveSnapshot={saveConfigSnapshot}
                    onRestoreSnapshot={restoreConfigSnapshot}
                    onResetPaper={resetPaperData}
                    onResetLive={resetLiveData}
                  />
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        <BottomNav tab={tab} setTab={go} items={navItems} badges={navBadges} />
      </SidebarInset>
    </>
  )
}

export default function PolyDashboard() {
  return (
    <WalletProviders>
      <AuthGate>
        <PolyDashboardApp />
      </AuthGate>
    </WalletProviders>
  )
}

function PolyDashboardApp() {
  const { state: poly, error, setState } = usePolyState(POLY_POLL_MS)
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [botBusy, setBotBusy] = useState(false)
  const [tab, setTab] = useState('overview')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    document.documentElement.classList.add('dark')
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    fetch('/api/poly/sync', { method: 'POST' }).catch(() => {})
    return () => clearInterval(id)
  }, [])

  // Agile toasts from bot notifications
  const lastToastRef = useRef(null)
  useEffect(() => {
    const n = poly?.notifications?.[0]
    if (!n?.id || n.id === lastToastRef.current) return
    lastToastRef.current = n.id
    const label = `${(n.type || 'bot').toUpperCase()} · ${(n.msg || '').slice(0, 120)}`
    if (n.type === 'error' || n.type === 'sl') toast.error(label)
    else if (n.type === 'buy' || n.type === 'arb' || n.type === 'tp') toast.success(label)
    else toast.message(label)
  }, [poly?.notifications])

  const navItems = useMemo(
    () => [
      {
        id: 'overview',
        label: 'Mission',
        shortLabel: 'Mission',
        description: 'Dataflow + ML bay',
        icon: Activity,
      },
      {
        id: 'markets',
        label: 'Markets',
        shortLabel: 'Markets',
        description: '5m windows + book',
        icon: LineChart,
      },
      {
        id: 'process',
        label: 'Process',
        shortLabel: 'Proc',
        description: 'Scan decisions + pipeline',
        icon: Cpu,
      },
      {
        id: 'traces',
        label: 'Traces',
        shortLabel: 'Trace',
        description: 'Decision + exit traces',
        icon: GitBranch,
      },
      {
        id: 'positions',
        label: 'Positions',
        shortLabel: 'Pos',
        description: 'Open fills',
        icon: Wallet,
      },
      {
        id: 'account',
        label: 'Account',
        shortLabel: 'Acct',
        description: 'USD equity · best · PnL card',
        icon: Activity,
      },
      {
        id: 'history',
        label: 'History',
        shortLabel: 'Hist',
        description: 'Closed trades',
        icon: History,
      },
      {
        id: 'log',
        label: 'Feed',
        shortLabel: 'Feed',
        description: 'Action stream',
        icon: ListOrdered,
      },
      {
        id: 'behavior',
        label: 'Behavior',
        shortLabel: 'Beh',
        description: 'Sizing & exits',
        icon: Settings2,
        mobile: false,
      },
    ],
    [],
  )

  // Hash pages: /#mission /#markets …
  useEffect(() => {
    const fromHash = () => {
      const h = (window.location.hash || '').replace(/^#/, '').toLowerCase()
      const map = {
        mission: 'overview',
        overview: 'overview',
        markets: 'markets',
        process: 'process',
        traces: 'traces',
        positions: 'positions',
        account: 'account',
        history: 'history',
        feed: 'log',
        log: 'log',
        behavior: 'behavior',
      }
      if (map[h]) setTab(map[h])
    }
    fromHash()
    window.addEventListener('hashchange', fromHash)
    return () => window.removeEventListener('hashchange', fromHash)
  }, [])

  useEffect(() => {
    const hashMap = {
      overview: 'mission',
      markets: 'markets',
      process: 'process',
      traces: 'traces',
      positions: 'positions',
      account: 'account',
      history: 'history',
      log: 'feed',
      behavior: 'behavior',
    }
    const next = hashMap[tab] || tab
    if (window.location.hash.replace(/^#/, '') !== next) {
      window.history.replaceState(null, '', `#${next}`)
    }
    const titles = {
      overview: 'Mission',
      markets: 'Markets',
      process: 'Process',
      traces: 'Traces',
      positions: 'Positions',
      account: 'Account',
      history: 'History',
      log: 'Feed',
      behavior: 'Behavior',
    }
    document.title = `Zinger · ${titles[tab] || 'Terminal'}`
  }, [tab])

  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey) return
      const ids = navItems.map((n) => n.id)
      const i = ids.indexOf(tab)
      if (i < 0) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setTab(ids[(i - 1 + ids.length) % ids.length])
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setTab(ids[(i + 1) % ids.length])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, navItems])

  const setCfg = async (patch, opts = {}) => {
    const r = await fetch('/api/poly/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!r.ok) {
      toast.error('Config update failed')
      throw new Error('config failed')
    }
    if (!opts.silent) toast.success(opts.toastMsg || 'Behavior updated')
    else if (opts.toastMsg) toast.success(opts.toastMsg)
  }

  const act = async (url, body, okMsg = 'Done') => {
    setBusy(true)
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await r.json()
      if (d.ok === false) toast.error(d.error || 'Failed')
      else toast.success(okMsg)
      return d
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const sync = async () => {
    setSyncing(true)
    try {
      await fetch('/api/poly/sync', { method: 'POST' })
      toast.success('Balances synced')
    } catch {
      toast.error('Sync failed')
    }
    setSyncing(false)
  }

  const approve = async (id) => {
    if (id === 'all') return act('/api/poly/approve-all', null, 'All trades approved')
    return act('/api/poly/approve', { id }, 'Trade approved')
  }

  const saveConfigSnapshot = async () => {
    const label = window.prompt('Snapshot name', `${String(poly?.mode || 'paper').toUpperCase()} config`)
    if (label == null) return
    await act('/api/poly/config-sessions', { label }, 'Config snapshot saved')
  }

  const restoreConfigSnapshot = async (id) => {
    const session = (poly?.configSessions || []).find((item) => item.id === id)
    if (!window.confirm(`Restore "${session?.label || 'this config'}"? Current settings will be backed up first.`)) return
    const result = await act('/api/poly/config-sessions/restore', { id }, 'Config restored')
    if (result?.ok) {
      const fresh = await fetch('/api/poly/state?lean=1')
      if (fresh.ok) setState(await fresh.json())
    }
  }

  const refreshState = async () => {
    const fresh = await fetch('/api/poly/state?lean=1')
    if (fresh.ok) setState(await fresh.json())
  }

  const resetPaperData = async () => {
    const confirmed = window.prompt('Type RESET PAPER to remove paper trades, positions, and PnL history.')
    if (confirmed !== 'RESET PAPER') {
      if (confirmed != null) toast.error('Paper reset cancelled — confirmation did not match')
      return
    }
    const result = await act(
      '/api/poly/paper-reset',
      { confirm: confirmed, initialDeposit: 100 },
      'Paper data reset to $100',
    )
    if (result?.ok) {
      const fresh = await fetch('/api/poly/state?lean=1')
      if (fresh.ok) setState(await fresh.json())
    }
  }

  const resetLiveData = async () => {
    const confirmed = window.prompt(
      'Type RESET LIVE to wipe phantom live trades/positions and re-baseline to current CLOB cash. Paper data is kept.',
    )
    if (confirmed !== 'RESET LIVE') {
      if (confirmed != null) toast.error('Live reset cancelled — confirmation did not match')
      return
    }
    const result = await act(
      '/api/poly/live-reset',
      { confirm: confirmed },
      'Live account normalized — clean slate',
    )
    if (result?.ok) {
      const fresh = await fetch('/api/poly/state?lean=1')
      if (fresh.ok) setState(await fresh.json())
    }
  }

  const toggleBot = async () => {
    if (!poly || botBusy) return
    const stopping = !!poly.running
    const url = stopping ? '/api/poly/stop' : '/api/poly/start'
    const cancellingQueuedStop = stopping && poly.stopRequest?.status === 'queued'
    setBotBusy(true)
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stopping ? JSON.stringify({ cancel: cancellingQueuedStop }) : undefined,
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.ok === false) {
        toast.error(d.error || (stopping ? 'Stop failed' : 'Start failed'))
      } else {
        if (typeof d.running === 'boolean') {
          setState((prev) => (prev
            ? {
                ...prev,
                running: d.running,
                stopRequest: d.queued ? d.stopRequest : null,
              }
            : prev))
        }
        if (d.queued) {
          const seconds = Math.max(0, Math.ceil((d.stopRequest?.executeAt - Date.now()) / 1000))
          toast.warning(`Stop queued — bot remains active for this window (${seconds}s)`)
        } else if (d.cancelled) {
          toast.success('Queued stop cancelled — bot remains active')
        } else {
          toast.success(stopping ? 'Bot stopped' : 'Bot started')
        }
        // Reconcile with canonical server state so no stale poll can undo the toggle
        try {
          const fresh = await fetch('/api/poly/state?lean=1')
          if (fresh.ok) {
            const fd = await fresh.json()
            setState((prev) => (prev ? { ...fd, charts: Object.keys(fd.charts || {}).length ? fd.charts : prev.charts } : fd))
          }
        } catch {}
      }
    } catch (e) {
      toast.error(e.message || 'Bot toggle failed')
    } finally {
      setBotBusy(false)
    }
  }

  if (!poly) {
    return (
      <div className="dark flex min-h-svh">
        <aside className="hidden w-[16rem] flex-col border-r border-sidebar-border bg-sidebar p-2 md:flex">
          <div className="flex items-center gap-3 px-2 py-1">
            <Skeleton className="size-9 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
          <div className="mt-6 space-y-1 px-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </aside>
        <main className="poly-shell flex min-w-0 flex-1 flex-col">
          <header className="border-b border-border/70 bg-background/90">
            <div className="flex items-center gap-3 px-3 py-2">
              <Skeleton className="size-8 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-8 w-28 rounded-md" />
            </div>
          </header>
          <div className="flex-1 space-y-2 p-2 sm:p-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-16 rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        </main>
      </div>
    )
  }

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={true} className="dark min-h-svh">
        <PolyShell
          poly={poly}
          error={error}
          tab={tab}
          setTab={setTab}
          navItems={navItems}
          syncing={syncing}
          sync={sync}
          act={act}
          setCfg={setCfg}
          settingsOpen={settingsOpen}
          setSettingsOpen={setSettingsOpen}
          busy={busy}
          approve={approve}
          toggleBot={toggleBot}
          botBusy={botBusy}
          saveConfigSnapshot={saveConfigSnapshot}
          restoreConfigSnapshot={restoreConfigSnapshot}
          resetPaperData={resetPaperData}
          resetLiveData={resetLiveData}
          refreshState={refreshState}
        />
      </SidebarProvider>
    </TooltipProvider>
  )
}
