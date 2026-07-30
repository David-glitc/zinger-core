import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import SystemFlow from '@/components/SystemFlow'
import MlBay from '@/components/MlBay'
import { LiveCountdown, LiveTimeAgo } from '@/polyTimers'
import { toast } from 'sonner'

function money(n, digits = 2) {
  const v = Number(n || 0)
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(digits)}`
}

function cycleClass(remaining) {
  const s = Number(remaining)
  if (!Number.isFinite(s)) return { id: '—', label: 'Unknown', tone: 'muted' }
  if (s <= 0) return { id: 'SETTLED', label: 'Cycle settled', tone: 'up' }
  if (s <= 8) return { id: 'ENDING', label: 'Ending / resolve', tone: 'down' }
  if (s <= 60) return { id: 'LATE', label: 'Late window', tone: 'amber' }
  return { id: 'OPEN', label: 'Open window', tone: 'up' }
}

function TapRow({ a }) {
  const t = a?.type || a?.level || 'sys'
  return (
    <div className="flex items-start gap-2 border-b border-border/40 py-1.5 last:border-0">
      <Badge variant="outline" className="mt-0.5 shrink-0 font-mono text-[0.55rem] uppercase">
        {String(t).slice(0, 8)}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.7rem] leading-snug">{a?.msg || a?.message || '—'}</div>
        <div className="text-muted-foreground font-mono text-[0.55rem]">
          {a?.time ? <LiveTimeAgo ts={a.time} /> : a?.timestamp ? <LiveTimeAgo ts={a.timestamp} /> : '—'}
        </div>
      </div>
    </div>
  )
}

function TradeRow({ t }) {
  const pnl = Number(t.pnl || 0)
  return (
    <div className="flex items-center gap-2 border-b border-border/40 py-1.5 font-mono text-[0.65rem] last:border-0">
      <span className="font-bold">{t.symbol}</span>
      <span className="text-muted-foreground uppercase">{t.outcome}</span>
      <Badge variant="outline" className="text-[0.55rem]">
        {t.exitReason || (t.closed ? 'closed' : 'open')}
      </Badge>
      <span className={cn('ml-auto', pnl >= 0 ? 'text-primary' : 'text-destructive')}>
        {pnl >= 0 ? '+' : ''}
        {money(pnl)}
      </span>
    </div>
  )
}

export default function MissionPage({
  poly,
  chartPack,
  displayMode,
  isPaper,
  portfolio,
  cash,
  livePnl,
  paperBankroll,
  liveMarkets,
  go,
  onDepositForms,
}) {
  const cycle = poly?.cycle || {}
  const remaining = cycle.remainingSeconds ?? Math.floor((cycle.remainingMs || 0) / 1000)
  const cls = cycleClass(remaining)
  const trades = (poly?.trades || []).slice(0, 12)
  const taps = (poly?.actions || poly?.executionLog || []).slice(0, 14)
  const settle = poly?.settle || {}
  const optimizer = poly?.optimizer || {}
  const lastOpt = optimizer.lastResult
  const rewards = settle.lastCycle || poly?.cycleReward || null
  const audit = poly?.audit || {}

  const runOpt = async () => {
    try {
      const r = await fetch('/api/poly/optimizer/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const d = await r.json()
      if (d.ok) toast.success(d.applied ? `Optimizer applied ${Object.keys(d.patch || {}).join(', ') || 'noop'}` : 'Optimizer ran (no change)')
      else toast.message(d.reason || d.error || 'Optimizer skipped')
    } catch (e) {
      toast.error(e.message || 'Optimizer failed')
    }
  }

  return (
    <div className="poly-panel poly-page flex flex-col gap-2 sm:gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2 pb-1">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Mission</h1>
          <p className="text-muted-foreground text-[0.7rem] leading-snug">
            Model canvas, bot tape, live taps, cycle settle · equity lives in the nav bar.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn(
              'font-mono',
              cls.tone === 'up' && 'border-primary/40 text-primary',
              cls.tone === 'down' && 'border-destructive/40 text-destructive',
              cls.tone === 'amber' && 'border-amber-500/40 text-amber-400',
            )}
          >
            {cls.id}
          </Badge>
          <span className="font-mono text-xs">
            <LiveCountdown
              endAtMs={cycle.endAtMs}
              fallbackMs={cycle.remainingMs}
              fallbackSeconds={cycle.remainingSeconds}
            />
          </span>
          <Button size="sm" variant="secondary" className="h-8" onClick={runOpt}>
            Fast optimize
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 sm:gap-2">
        <div className="data-tile">
          <div className="text-muted-foreground text-[0.55rem] uppercase tracking-wider">Cycle</div>
          <div className="font-mono text-sm font-semibold">{cls.label}</div>
        </div>
        <div className="data-tile">
          <div className="text-muted-foreground text-[0.55rem] uppercase tracking-wider">Settle rewards</div>
          <div className={cn('font-mono text-sm font-semibold', Number(rewards?.pnl || 0) >= 0 ? 'text-primary' : 'text-destructive')}>
            {rewards ? money(rewards.pnl) : '—'}
          </div>
          <div className="text-muted-foreground font-mono text-[0.55rem]">
            {rewards?.closes != null ? `${rewards.closes} closes` : 'awaiting settle'}
          </div>
        </div>
        <div className="data-tile">
          <div className="text-muted-foreground text-[0.55rem] uppercase tracking-wider">Optimizer</div>
          <div className="font-mono text-sm font-semibold">
            {lastOpt?.applied ? 'applied' : lastOpt ? 'idle' : '—'}
          </div>
          <div className="text-muted-foreground truncate font-mono text-[0.55rem]">
            {(lastOpt?.reasons?.[0] || 'heuristic + LLM on closes').slice(0, 42)}
          </div>
        </div>
        <div className="data-tile">
          <div className="text-muted-foreground text-[0.55rem] uppercase tracking-wider">Net</div>
          <div className={cn('font-mono text-sm font-semibold', livePnl >= 0 ? 'text-primary' : 'text-destructive')}>
            {money(livePnl)}
          </div>
          <div className="text-muted-foreground font-mono text-[0.55rem]">
            {isPaper ? `cash ${money(cash)}` : `eq ${money(portfolio?.equity ?? cash)}`}
          </div>
        </div>
      </div>

      {audit.issues?.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 text-xs">
          <div className="mb-1 font-medium">Audit</div>
          <ul className="text-muted-foreground list-disc space-y-0.5 pl-4">
            {audit.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <SystemFlow
        running={poly.running}
        mode={displayMode}
        mlAlive={Boolean(poly.mlTraces?.btc || poly.mlTraces?.eth || poly.intelligence?.btc || poly.intelligence?.eth)}
        lastScan={poly.lastScan?.time || poly.lastScan}
        models={poly.models || []}
      />

      <MlBay
        mlTraces={poly.mlTraces || chartPack?.mlTraces || {}}
        intelligence={poly.intelligence || {}}
        confidenceBuffer={poly.confidenceBuffer || {}}
        models={poly.models || []}
      />

      <div className="grid gap-2 lg:grid-cols-2">
        <Card>
          <CardHeader className="px-3 py-2">
            <CardTitle className="text-base">Bot trades</CardTitle>
            <CardDescription>Recent closes + opens in {displayMode}</CardDescription>
          </CardHeader>
          <CardContent className="px-3 pb-2">
            {trades.length === 0 ? (
              <div className="text-muted-foreground py-6 text-center text-sm">No trades yet</div>
            ) : (
              trades.map((t, i) => <TradeRow key={t.id || i} t={t} />)
            )}
            <Button size="sm" variant="outline" className="mt-2 h-8 w-full" onClick={() => go('history')}>
              Full history
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-3 py-2">
            <CardTitle className="text-base">Live taps</CardTitle>
            <CardDescription>Execution + scan stream</CardDescription>
          </CardHeader>
          <CardContent className="max-h-72 overflow-y-auto px-3 pb-2">
            {taps.length === 0 ? (
              <div className="text-muted-foreground py-6 text-center text-sm">Quiet</div>
            ) : (
              taps.map((a, i) => <TapRow key={a.id || i} a={a} />)
            )}
            <Button size="sm" variant="outline" className="mt-2 h-8 w-full" onClick={() => go('log')}>
              Open feed
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-col items-start gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">Live markets</CardTitle>
              <CardDescription>{liveMarkets.length} windows</CardDescription>
            </div>
            <Button size="sm" variant="outline" className="h-8" onClick={() => go('markets')}>
              Markets
            </Button>
          </CardHeader>
          <CardContent className="space-y-1 px-3 pb-3 font-mono text-[0.65rem]">
            {liveMarkets.slice(0, 4).map((m) => (
              <div key={m.slug} className="flex justify-between gap-2 border-b border-border/40 py-1 last:border-0">
                <span className="font-bold">{m.symbol}</span>
                <span className="text-muted-foreground">{m.remaining}s</span>
                <span>
                  U {m.prices?.up != null ? Number(m.prices.up).toFixed(3) : '—'} / D{' '}
                  {m.prices?.down != null ? Number(m.prices.down).toFixed(3) : '—'}
                </span>
                <span className="uppercase text-muted-foreground">{m.action || '—'}</span>
              </div>
            ))}
            {!liveMarkets.length && <div className="text-muted-foreground py-4 text-center">No live windows</div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-3 py-2">
            <CardTitle className="text-base">{isPaper ? 'Paper account' : 'Account'}</CardTitle>
            <CardDescription>{isPaper ? 'Virtual bankroll' : 'Wallet'}</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 px-3 pb-3 text-sm">
            {isPaper ? (
              <>
                <div>
                  <div className="text-muted-foreground text-xs">Bankroll</div>
                  <div className="font-mono text-primary">{money(paperBankroll ?? 100)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Equity</div>
                  <div className="font-mono">{money(portfolio?.equity)}</div>
                </div>
                {onDepositForms}
              </>
            ) : (
              <>
                <div>
                  <div className="text-muted-foreground text-xs">Cash</div>
                  <div className="font-mono text-primary">{money(cash)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Equity</div>
                  <div className="font-mono">{money(portfolio?.equity ?? cash)}</div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
