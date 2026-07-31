// @ts-nocheck
import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

function money(n, digits = 2) {
  const v = Number(n || 0)
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(digits)}`
}

function EquitySvg({ points = [], height = 200 }) {
  const pts = (points || []).filter((p) => Number.isFinite(Number(p.equity)))
  if (pts.length < 2) {
    return (
      <div className="text-muted-foreground flex h-[200px] items-center justify-center font-mono text-xs">
        Equity curve warming — points land as the bot marks cash.
      </div>
    )
  }
  const vals = pts.map((p) => Number(p.equity))
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = Math.max(0.01, max - min)
  const w = 640
  const h = height
  const pad = 12
  const path = pts
    .map((p, i) => {
      const x = pad + (i / (pts.length - 1)) * (w - pad * 2)
      const y = pad + (1 - (Number(p.equity) - min) / span) * (h - pad * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const last = vals[vals.length - 1]
  const first = vals[0]
  const up = last >= first
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[200px] w-full" role="img" aria-label="USD equity curve">
      <path d={path} fill="none" stroke={up ? '#34d399' : '#f87171'} strokeWidth="2.5" />
      <text x={pad} y={h - 4} fill="#64748b" fontSize="10" fontFamily="ui-monospace,monospace">
        {money(min)} → {money(max)}
      </text>
    </svg>
  )
}

/**
 * Core Account tab — book overview, equity curve, best trades, session snapshot, audit.
 * Live tape / NLP / score strip live in the global header strip (not duplicated here).
 */
export default function AccountPage({ poly, onSyncBaseline, busy }) {
  const account = poly?.account || {}
  const stats = account.stats || {}
  const curve = account.curve?.points || []
  const snapshot = account.snapshot
  const live = account.liveAccount || poly?.liveAccount || {}
  const ca = poly?.cashAudit || {}
  const narrative = poly?.narrative
  const mode = poly?.mode || poly?.config?.mode || 'paper'

  const best = stats.best || []
  const closedPm = live.closed || []
  const traceLines = (narrative?.lines || []).slice(1, 8)

  const auditTone = ca.ok === false ? 'down' : 'up'

  const kpis = useMemo(
    () => [
      { label: 'Equity', value: money(ca.equity ?? poly?.portfolio?.equity), tone: 'muted' },
      { label: 'Cash', value: money(ca.cash ?? poly?.portfolio?.cash), tone: 'muted' },
      {
        label: 'Net PnL',
        value: money(ca.netPnl ?? stats.totalPnl),
        tone: Number(ca.netPnl ?? stats.totalPnl) >= 0 ? 'up' : 'down',
      },
      {
        label: 'PM closed',
        value: money(stats.pmRealizedSum ?? ca.pmRealizedSum),
        tone: Number(stats.pmRealizedSum ?? ca.pmRealizedSum ?? 0) >= 0 ? 'up' : 'down',
      },
    ],
    [ca, poly, stats],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2">
        <p className="text-muted-foreground text-xs">
          {String(mode).toUpperCase()} book · source {ca.pnlSource || '—'} · WR{' '}
          {stats.winRate != null ? `${stats.winRate}%` : '—'} · {curve.length} equity marks
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Badge
            variant="outline"
            className={cn(
              auditTone === 'up' && 'border-primary/40 text-primary',
              auditTone === 'down' && 'border-destructive/40 text-destructive',
            )}
          >
            Audit {ca.ok === false ? 'ISSUES' : 'OK'}
          </Badge>
          {onSyncBaseline && (
            <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={onSyncBaseline}>
              Rebase baseline → cash
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="gap-0 border-border/60 bg-card/80 py-0 shadow-none">
            <CardContent className="px-3 py-2.5">
              <div className="text-muted-foreground text-[0.55rem] uppercase tracking-wider">{k.label}</div>
              <div
                className={cn(
                  'font-mono text-base font-bold tabular-nums',
                  k.tone === 'up' && 'text-primary',
                  k.tone === 'down' && 'text-destructive',
                )}
              >
                {k.value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader className="px-3 py-2">
            <CardTitle className="text-base">USD equity</CardTitle>
            <CardDescription>Session-aware curve from live marks</CardDescription>
          </CardHeader>
          <CardContent className="px-2 pb-2">
            <EquitySvg points={curve} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-3 py-2">
            <CardTitle className="text-base">Session snapshot</CardTitle>
            <CardDescription>Shareable PnL card for this session</CardDescription>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            {snapshot?.dataUrl ? (
              <img
                src={snapshot.dataUrl}
                alt="Session PnL snapshot"
                className="w-full rounded-lg border border-border/60"
              />
            ) : (
              <div className="text-muted-foreground flex h-[200px] items-center justify-center text-xs">
                Snapshot unavailable.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="px-3 py-2">
            <CardTitle className="text-base">Best trades</CardTitle>
            <CardDescription>Top closes by PnL</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 px-3 pb-3">
            {best.length === 0 ? (
              <div className="text-muted-foreground text-xs">No closed trades yet.</div>
            ) : (
              best.map((t) => (
                <div
                  key={t.id || `${t.slug}-${t.timestamp}`}
                  className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 font-mono text-[0.7rem]"
                >
                  <span className="font-bold">{t.symbol}</span>
                  <span className="text-muted-foreground uppercase">{t.outcome}</span>
                  <Badge variant="outline" className="text-[0.5rem]">
                    {t.exitReason || '—'}
                  </Badge>
                  <span
                    className={cn(
                      'ml-auto font-bold',
                      Number(t.pnl) >= 0 ? 'text-primary' : 'text-destructive',
                    )}
                  >
                    {money(t.pnl)}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {traceLines.length > 0 ? (
          <Card className="border-border/60 bg-card/50">
            <CardHeader className="px-3 py-2">
              <CardTitle className="text-base">Trace detail</CardTitle>
              <CardDescription>Expanded system trace (headline is in the live strip above)</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 px-3 pb-3">
              {traceLines.map((line, i) => (
                <div key={i} className="text-muted-foreground text-[0.7rem] leading-snug">
                  · {line.text}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed">
            <CardContent className="text-muted-foreground flex h-full min-h-[120px] items-center justify-center px-3 py-6 text-xs">
              Trace detail fills in as the bot runs.
            </CardContent>
          </Card>
        )}
      </div>

      {(ca.issues || []).length > 0 ? (
        <Card className="border-destructive/40">
          <CardHeader className="px-3 py-2">
            <CardTitle className="text-base">Audit issues</CardTitle>
            <CardDescription>Hard ledger identity / cash sync failures</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 px-3 pb-3 font-mono text-[0.7rem]">
            {(ca.issues || []).map((iss, i) => (
              <div key={`i-${i}`} className="text-destructive">
                ! {iss}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {closedPm.length > 0 && (
        <Card>
          <CardHeader className="px-3 py-2">
            <CardTitle className="text-base">Polymarket closed</CardTitle>
            <CardDescription>Ground-truth closes from live account sync</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 px-3 pb-3">
            {closedPm.slice(0, 10).map((c) => (
              <div
                key={c.key || c.slug}
                className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5 font-mono text-[0.65rem]"
              >
                <span className="truncate">{c.title || c.slug}</span>
                <span
                  className={cn(
                    'ml-auto shrink-0 font-bold',
                    Number(c.realizedPnl) >= 0 ? 'text-primary' : 'text-destructive',
                  )}
                >
                  {money(c.realizedPnl)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
