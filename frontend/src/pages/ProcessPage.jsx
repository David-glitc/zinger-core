import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import SystemFlow from '@/components/SystemFlow'
import PipelineView from '@/components/PipelineView'
import { LiveTimeAgo, fmtTimeMs } from '@/polyTimers'

function money(n, digits = 2) {
  const v = Number(n || 0)
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(digits)}`
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

function DecisionCard({ d }) {
  const action = d?.action || d?.decision?.action || 'hold'
  const summary = d?.decision?.summary || `${action} ${d?.symbol || ''}`
  const trace = d?.decision?.trace || []
  const candidates = d?.candidates || []
  return (
    <div className="rounded-lg border border-border/70 bg-card/70 p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-sm font-bold">{d.symbol}</span>
        <Badge
          variant="outline"
          className={cn(
            'uppercase',
            action === 'buy' && 'border-primary/40 text-primary',
            action === 'hold' && 'text-muted-foreground',
            action === 'announce' && 'border-amber-500/40 text-amber-400',
          )}
        >
          {action}
        </Badge>
        {d.remaining != null && (
          <span className="text-muted-foreground font-mono text-[0.65rem]">{d.remaining}s left</span>
        )}
        {d.prices?.up != null && (
          <span className="ml-auto font-mono text-[0.65rem]">
            U {Number(d.prices.up).toFixed(3)} / D {Number(d.prices.down).toFixed(3)}
          </span>
        )}
      </div>
      <div className="text-xs font-medium">{summary}</div>
      {trace.length > 0 && (
        <ul className="text-muted-foreground mt-1.5 space-y-0.5 font-mono text-[0.6rem]">
          {trace.slice(0, 6).map((t, i) => (
            <li key={i}>· {t}</li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && (
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {candidates.map((c, i) => (
            <div
              key={i}
              className={cn(
                'rounded border px-1.5 py-1 font-mono text-[0.6rem]',
                c.eligible ? 'border-primary/30 bg-primary/5' : 'border-border/60 bg-muted/20',
              )}
            >
              <div className="flex justify-between gap-1">
                <span className="uppercase">{c.outcome}</span>
                <span>{c.eligible ? `score ${Number(c.score || 0).toFixed(0)}` : 'blocked'}</span>
              </div>
              {c.price != null && <div className="text-muted-foreground">@{Number(c.price).toFixed(3)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ProcessPage({ poly }) {
  const process = poly?.process || {}
  const decisions = process.decisions || []
  const portfolio = poly?.portfolio || {}
  const sizing = process.lastSizing || poly?.sizing
  const pending = poly?.pendingTrades || poly?.orders || []
  const llm = poly?.llm || {}

  return (
    <div className="poly-panel poly-page flex flex-col gap-2 sm:gap-3">
      <PageIntro
        title="Bot process"
        description="Live scan phase, decision traces, sizing, pending orders, and pipeline health."
      />

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 sm:gap-2">
        <div className="data-tile">
          <div className="lbl">Phase</div>
          <div className="val text-xs uppercase">{process.phase || (poly?.running ? 'idle' : 'stopped')}</div>
        </div>
        <div className="data-tile">
          <div className="lbl">Scans</div>
          <div className="val text-xs">{process.scansDone ?? poly?.stats?.scansDone ?? 0}</div>
        </div>
        <div className="data-tile">
          <div className="lbl">Last scan</div>
          <div className="val text-xs">
            {process.lastScanAt || poly?.lastScan ? (
              <LiveTimeAgo ts={process.lastScanAt || poly?.lastScan} />
            ) : (
              '—'
            )}
          </div>
        </div>
        <div className="data-tile">
          <div className="lbl">LLM</div>
          <div className={cn('val text-xs', llm.configured ? 'text-primary' : 'text-destructive')}>
            {llm.configured ? 'wired' : 'no key'}
          </div>
        </div>
      </div>

      <SystemFlow
        running={poly?.running}
        mode={poly?.mode || poly?.config?.mode}
        mlAlive={Boolean(poly?.mlTraces?.btc || poly?.mlTraces?.eth || poly?.intelligence?.btc)}
        lastScan={poly?.lastScan?.time || poly?.lastScan}
        models={poly?.models || []}
      />

      <div className="grid gap-2 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="gap-0 border-border/60 bg-card/80 py-0 shadow-none">
          <CardHeader className="border-b border-border/50 px-3 py-2">
            <CardTitle className="text-sm">Current window decisions</CardTitle>
            <CardDescription className="text-[0.7rem]">
              Why buy / hold fired on this scan cycle
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 p-2.5">
            {decisions.length === 0 ? (
              <div className="text-muted-foreground py-6 text-center text-xs">Waiting for scan…</div>
            ) : (
              decisions.map((d) => <DecisionCard key={d.slug || d.symbol} d={d} />)
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2">
          <Card className="gap-0 border-border/60 bg-card/80 py-0 shadow-none">
            <CardHeader className="border-b border-border/50 px-3 py-2">
              <CardTitle className="text-sm">PnL tape</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-1.5 p-2.5 font-mono text-xs">
              <div>
                <div className="text-muted-foreground text-[0.6rem]">Net</div>
                <div className={Number(portfolio.netPnl || 0) >= 0 ? 'text-primary' : 'text-destructive'}>
                  {money(portfolio.netPnl)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-[0.6rem]">Realized</div>
                <div>{money(portfolio.realizedPnl)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-[0.6rem]">Unrealized</div>
                <div className={Number(portfolio.unrealizedPnl || 0) >= 0 ? 'text-primary' : 'text-destructive'}>
                  {money(portfolio.unrealizedPnl)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-[0.6rem]">Equity</div>
                <div>{money(portfolio.equity)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-[0.6rem]">Cash</div>
                <div>{money(portfolio.cash)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-[0.6rem]">Open mark</div>
                <div>{money(portfolio.openMarkValue)}</div>
              </div>
            </CardContent>
          </Card>

          <Card className="gap-0 border-border/60 bg-card/80 py-0 shadow-none">
            <CardHeader className="border-b border-border/50 px-3 py-2">
              <CardTitle className="text-sm">Sizing</CardTitle>
            </CardHeader>
            <CardContent className="p-2.5 font-mono text-[0.65rem]">
              {sizing ? (
                <div className="space-y-0.5 text-muted-foreground">
                  <div>
                    size <span className="text-foreground">{money(sizing.sizeUsd)}</span>
                  </div>
                  {sizing.kellyFraction != null && <div>kelly {Number(sizing.kellyFraction).toFixed(2)}%</div>}
                  {sizing.method && <div>method {sizing.method}</div>}
                  {sizing.limits && (
                    <div>
                      lim {money(sizing.limits.minUsd)}–{money(sizing.limits.maxUsd)}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-muted-foreground text-xs">No sizing yet</div>
              )}
            </CardContent>
          </Card>

          <div className="pipeline-host min-h-[7.5rem]">
            <PipelineView />
          </div>
        </div>
      </div>

      <Card className="gap-0 border-border/60 bg-card/80 py-0 shadow-none">
        <CardHeader className="border-b border-border/50 px-3 py-2">
          <CardTitle className="text-sm">Live orders / announces</CardTitle>
          <CardDescription className="text-[0.7rem]">{pending.length} pending</CardDescription>
        </CardHeader>
        <CardContent className="p-2">
          {pending.length === 0 ? (
            <div className="text-muted-foreground py-4 text-center text-xs">No pending orders</div>
          ) : (
            <div className="space-y-1">
              {pending.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-xs"
                >
                  <Badge variant="outline">{p.status || 'pending'}</Badge>
                  <span className="font-semibold">
                    {p.symbol} {String(p.outcome || '').toUpperCase()}
                  </span>
                  <span className="font-mono text-muted-foreground">
                    @{Number(p.plan?.entryPrice || 0).toFixed(3)} · {money(p.plan?.sizeUsd || p.plan?.costEst)}
                  </span>
                  <span className="text-muted-foreground ml-auto font-mono text-[0.6rem]">
                    {fmtTimeMs(p.createdAt || p.time)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
