// @ts-nocheck
import { useMemo } from 'react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { fmtTimeMs } from '@/polyTimers'

function buildStepPath(points, key, xScale, yScale) {
  const usable = points.filter((p) => p[key] != null && Number.isFinite(Number(p[key])))
  if (usable.length < 2) return ''
  let d = ''
  for (let i = 0; i < usable.length; i += 1) {
    const p = usable[i]
    const x = xScale(p.t)
    const y = yScale(Number(p[key]))
    if (i === 0) {
      d += `M${x.toFixed(1)},${y.toFixed(1)}`
      continue
    }
    const prevX = xScale(usable[i - 1].t)
    d += `L${x.toFixed(1)},${yScale(Number(usable[i - 1][key])).toFixed(1)}`
    if (x !== prevX) d += `L${x.toFixed(1)},${y.toFixed(1)}`
  }
  return d
}

function buildAreaPath(points, key, xScale, yScale, floorY) {
  const usable = points.filter((p) => p[key] != null && Number.isFinite(Number(p[key])))
  if (usable.length < 2) return ''
  const top = usable
    .map((p, i) => {
      const x = xScale(p.t)
      const y = yScale(Number(p[key]))
      if (i === 0) return `M${x.toFixed(1)},${floorY.toFixed(1)}L${x.toFixed(1)},${y.toFixed(1)}`
      const prevY = yScale(Number(usable[i - 1][key]))
      return `L${x.toFixed(1)},${prevY.toFixed(1)}L${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join('')
  const endX = xScale(usable[usable.length - 1].t)
  return `${top}L${endX.toFixed(1)},${floorY.toFixed(1)}Z`
}

function pct(v) {
  if (!Number.isFinite(Number(v))) return '—'
  return `${Math.round(Number(v) * 100)}%`
}

export default function ChartPanel({ market, ticks = [], mlTrace = null, className }) {
  const series = useMemo(() => {
    const raw = Array.isArray(ticks) ? ticks : []
    return raw
      .filter((p) => p && (p.up != null || p.down != null) && Number.isFinite(Number(p.t)))
      .slice(-260)
  }, [ticks])

  const chart = useMemo(() => {
    const w = 700
    const h = 250
    const pad = { top: 16, right: 14, bottom: 26, left: 44 }
    if (series.length < 2) {
      return { w, h, pad, minY: 0, maxY: 1, upPath: '', downPath: '', upArea: '', downArea: '', last: null }
    }

    const t0 = Number(series[0].t)
    const t1 = Number(series[series.length - 1].t) || t0 + 1
    const vals = series.flatMap((p) => [p.up, p.down].filter((v) => Number.isFinite(Number(v))).map(Number))

    let minY = Math.max(0, Math.min(...vals, 0.01))
    let maxY = Math.min(1, Math.max(...vals, 0.99))
    const span = Math.max(0.02, maxY - minY)
    minY = Math.max(0.01, minY - span * 0.12)
    maxY = Math.min(0.99, maxY + span * 0.12)

    const xScale = (t) => pad.left + ((Number(t) - t0) / (t1 - t0 || 1)) * (w - pad.left - pad.right)
    const yScale = (v) => pad.top + (1 - (Number(v) - minY) / (maxY - minY || 1)) * (h - pad.top - pad.bottom)
    const floorY = h - pad.bottom

    return {
      w,
      h,
      pad,
      minY,
      maxY,
      upPath: buildStepPath(series, 'up', xScale, yScale),
      downPath: buildStepPath(series, 'down', xScale, yScale),
      upArea: buildAreaPath(series, 'up', xScale, yScale, floorY),
      downArea: buildAreaPath(series, 'down', xScale, yScale, floorY),
      last: series[series.length - 1],
      t0,
      t1,
      xScale,
      yScale,
    }
  }, [series])

  const label = market ? `${market.symbol} · ${(market.slug || '').slice(0, 30)}` : 'Market probability'
  const tracePoints = Array.isArray(mlTrace?.prices) ? mlTrace.prices : Array.isArray(mlTrace) ? mlTrace : []

  return (
    <Card className={cn('poly-chart-slot border-border/60 bg-card/90', className)}>
      <CardHeader className="flex flex-row items-start gap-2 border-b border-border/60 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <CardTitle className="text-[0.65rem] font-semibold tracking-[0.14em] uppercase text-muted-foreground">
            Polymarket style
          </CardTitle>
          <CardDescription className="truncate font-mono text-xs text-foreground">{label}</CardDescription>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {chart.last?.up != null && (
            <Badge variant="outline" className="font-mono text-[0.55rem] text-primary">
              YES {pct(chart.last.up)}
            </Badge>
          )}
          {chart.last?.down != null && (
            <Badge variant="outline" className="font-mono text-[0.55rem] text-destructive">
              NO {pct(chart.last.down)}
            </Badge>
          )}
          {chart.last?.t && (
            <Badge variant="secondary" className="font-mono text-[0.55rem]">
              {fmtTimeMs(chart.last.t)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-2 pb-2 pt-2">
        {series.length < 2 ? (
          <div className="text-muted-foreground flex h-[190px] items-center justify-center text-center text-xs">
            Collecting market ticks…
          </div>
        ) : (
          <svg viewBox={`0 0 ${chart.w} ${chart.h}`} className="h-[190px] w-full" role="img" aria-label="YES/NO probability chart">
            <defs>
              <linearGradient id="pmUp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(200,255,0,0.30)" />
                <stop offset="100%" stopColor="rgba(200,255,0,0.02)" />
              </linearGradient>
              <linearGradient id="pmDn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(255,59,74,0.20)" />
                <stop offset="100%" stopColor="rgba(255,59,74,0.02)" />
              </linearGradient>
            </defs>

            {[0.2, 0.4, 0.6, 0.8].map((f) => {
              const y = chart.pad.top + f * (chart.h - chart.pad.top - chart.pad.bottom)
              const val = chart.maxY - f * (chart.maxY - chart.minY)
              return (
                <g key={f}>
                  <line
                    x1={chart.pad.left}
                    x2={chart.w - chart.pad.right}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    className="text-border"
                    strokeWidth="1"
                    opacity="0.55"
                  />
                  <text
                    x={chart.pad.left - 5}
                    y={y + 3}
                    textAnchor="end"
                    className="fill-muted-foreground"
                    fontSize="10"
                    fontFamily="ui-monospace, monospace"
                  >
                    {pct(val)}
                  </text>
                </g>
              )
            })}

            {chart.downArea && <path d={chart.downArea} fill="url(#pmDn)" />}
            {chart.upArea && <path d={chart.upArea} fill="url(#pmUp)" />}
            {chart.downPath && <path d={chart.downPath} fill="none" className="stroke-destructive" strokeWidth="1.8" />}
            {chart.upPath && <path d={chart.upPath} fill="none" className="stroke-primary" strokeWidth="2" />}

            {chart.last && (
              <line
                x1={chart.xScale(chart.last.t)}
                x2={chart.xScale(chart.last.t)}
                y1={chart.pad.top}
                y2={chart.h - chart.pad.bottom}
                stroke="rgba(255,255,255,0.14)"
                strokeDasharray="2 3"
              />
            )}

            {chart.last && tracePoints.length > 0 && (() => {
              const mid = chart.last.up != null && chart.last.down != null
                ? (Number(chart.last.up) + (1 - Number(chart.last.down))) / 2
                : Number(chart.last.up ?? chart.last.down)
              if (!Number.isFinite(mid)) return null
              const x0 = chart.w - chart.pad.right - 8
              return tracePoints.slice(0, 4).map((pt, i) => {
                const dir = pt.direction === 'up' || pt.direction === 1 ? 1 : pt.direction === 'down' || pt.direction === -1 ? -1 : 0
                const proj = Math.min(0.99, Math.max(0.01, mid + dir * Math.abs(Number(pt.expectedReturn || 0.01)) * (i + 1)))
                const x = x0 - (tracePoints.length - i) * 14
                const y = chart.yScale(proj)
                return (
                  <g key={i}>
                    <circle cx={x} cy={y} r="3" className={dir >= 0 ? 'fill-primary' : 'fill-destructive'} opacity="0.9" />
                    <text x={x} y={y - 6} textAnchor="middle" className="fill-muted-foreground" fontSize="9" fontFamily="ui-monospace, monospace">
                      {pt.label || `${pt.minutes || '?'}m`}
                    </text>
                  </g>
                )
              })
            })()}

            <text x={chart.pad.left} y={chart.h - 6} className="fill-muted-foreground" fontSize="10" fontFamily="ui-monospace, monospace">
              {fmtTimeMs(series[0].t)}
            </text>
            <text x={chart.w - chart.pad.right} y={chart.h - 6} textAnchor="end" className="fill-muted-foreground" fontSize="10" fontFamily="ui-monospace, monospace">
              {fmtTimeMs(series[series.length - 1].t)}
            </text>
          </svg>
        )}
        <div className="text-muted-foreground mt-1 flex items-center gap-3 px-1 font-mono text-[0.58rem]">
          <span className="text-primary">━ YES</span>
          <span className="text-destructive">━ NO</span>
          <span>· {series.length} ticks</span>
          {tracePoints.length > 0 && <span>· ML {tracePoints.length} pts</span>}
        </div>
      </CardContent>
    </Card>
  )
}
