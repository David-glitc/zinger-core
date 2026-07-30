import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

function money(n, digits = 2) {
  const v = Number(n || 0)
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(digits)}`
}

function TraceLadder({ label, trace }) {
  const prices = trace?.prices || []
  const age = trace?.ageMs != null ? `${Math.round(trace.ageMs / 1000)}s` : '—'
  return (
    <div className="data-tile min-h-[3.5rem]">
      <div className="lbl flex items-center justify-between gap-2">
        <span>{label}</span>
        <span className="normal-case tracking-normal">{age}</span>
      </div>
      {prices.length === 0 ? (
        <div className="text-muted-foreground mt-1 text-xs">awaiting ladder</div>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1">
          {prices.map((p, i) => {
            const dir =
              typeof p === 'object'
                ? p.direction === 'up' || p.direction === 1
                  ? 1
                  : p.direction === 'down' || p.direction === -1
                    ? -1
                    : 0
                : Number(p) >= 0
                  ? 1
                  : -1
            const ret =
              typeof p === 'object'
                ? Number(p.expectedReturn ?? p.confidence ?? 0)
                : Number(p)
            const tag = typeof p === 'object' ? p.label || `${p.minutes ?? i + 1}m` : `h${i + 1}`
            return (
              <span
                key={i}
                className={cn(
                  'rounded border px-1.5 py-0.5 text-xs',
                  dir >= 0
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-destructive/30 bg-destructive/10 text-destructive',
                )}
              >
                {tag} {dir >= 0 ? '↑' : '↓'}
                {(Math.abs(ret) * 100).toFixed(2)}%
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ModelPills({ models = [] }) {
  const [hovered, setHovered] = useState(null)
  if (models.length === 0) return null
  const color = (status) => {
    if (status === 'healthy') return 'border-green-500/40 bg-green-500/10 text-green-400'
    if (status === 'running') return 'border-yellow-400/40 bg-yellow-400/10 text-yellow-400'
    if (status === 'error') return 'border-red-500/40 bg-red-500/10 text-red-400'
    return 'border-border/50 bg-muted/20 text-muted-foreground'
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {models.map((m) => {
        const dir = m.direction === 'up' ? '\u2191' : m.direction === 'down' ? '\u2193' : '\u2014'
        const conf = m.confidence != null ? `${(m.confidence * 100).toFixed(0)}%` : ''
        return (
          <div key={m.id} className="relative">
            <span
              className={cn(
                'cursor-default rounded border px-1.5 py-0.5 font-mono text-[0.65rem] transition-all',
                color(m.status),
                hovered === m.id && 'ring-1 ring-primary/50 scale-105',
              )}
              onMouseEnter={() => setHovered(m.id)}
              onMouseLeave={() => setHovered(null)}
            >
              {m.label} {dir}
              {conf}
            </span>
            {hovered === m.id && (
              <div className="absolute bottom-full left-1/2 z-50 mb-1.5 min-w-[160px] -translate-x-1/2">
                <div className="rounded-lg border border-primary/30 bg-[#0d1117] px-3 py-2 text-xs shadow-xl">
                  <div className="mb-1 font-mono text-[0.65rem] font-bold text-primary">{m.label}</div>
                  <div className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                    <span>
                      Status:{' '}
                      <span
                        className={
                          m.status === 'healthy'
                            ? 'text-green-400'
                            : m.status === 'error'
                              ? 'text-red-400'
                              : 'text-yellow-400'
                        }
                      >
                        {m.status}
                      </span>
                    </span>
                    <span>
                      Symbol: {m.symbol} · TF: {m.timeframe}
                    </span>
                    <span>Horizon: h{m.horizon}</span>
                    <span>
                      Direction:{' '}
                      {m.direction === 'up'
                        ? '↑ BULLISH'
                        : m.direction === 'down'
                          ? '↓ BEARISH'
                          : '→ NEUTRAL'}
                    </span>
                    <span>Confidence: {conf || '—'}</span>
                    {m.score != null && <span>Score: {m.score.toFixed(3)}</span>}
                    {m.error && <span className="text-red-400">Error: {m.error}</span>}
                    {m.predictions != null && <span>Predictions: {m.predictions}</span>}
                    {m.accuracy != null && <span>Accuracy: {(m.accuracy * 100).toFixed(0)}%</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function MlBay({ mlTraces = {}, intelligence = {}, confidenceBuffer = {}, models = [] }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/80 p-2.5 sm:p-3">
      <div className="mb-2 flex items-end justify-between gap-2">
        <div>
          <div className="font-mono text-[0.6rem] tracking-[0.18em] text-primary uppercase">ML inference bay</div>
          <div className="text-sm font-semibold tracking-tight">Named model outputs</div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline" className="font-mono text-[0.55rem]">
            LSTM ladder
          </Badge>
          <Badge variant="outline" className="font-mono text-[0.55rem]">
            {models.length} models
          </Badge>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2 md:gap-3">
        {['btc', 'eth'].map((asset) => {
          const intel = intelligence[asset]
          const trace = mlTraces[asset]
          const conf = confidenceBuffer[asset]
          const consensus = conf?.consensus || conf
          const assetModels = models.filter(
            (m) => String(m.symbol || '').toLowerCase() === asset,
          )
          return (
            <div
              key={asset}
              className="rounded-md border border-border/60 bg-background/50 p-2 transition-colors hover:border-primary/30 sm:p-2.5"
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="font-mono text-sm font-bold uppercase tracking-wider">{asset}</div>
                <div className="flex flex-wrap justify-end gap-1">
                  {intel?.direction && (
                    <Badge
                      variant="outline"
                      className={cn(
                        'uppercase',
                        intel.direction === 'up' && 'border-primary/40 text-primary',
                        intel.direction === 'down' && 'border-destructive/40 text-destructive',
                      )}
                    >
                      {intel.direction}
                    </Badge>
                  )}
                  {intel?.conviction && <Badge variant="secondary">{intel.conviction}</Badge>}
                  {intel?.regime && <Badge variant="outline">{intel.regime}</Badge>}
                </div>
              </div>
              <div className="mb-1.5 grid grid-cols-2 gap-1 sm:grid-cols-4 sm:gap-1.5">
                <div className="data-tile transition-colors hover:border-primary/40">
                  <div className="lbl">Score</div>
                  <div className="val text-xs">{intel?.score?.toFixed?.(1) ?? '—'}</div>
                </div>
                <div className="data-tile transition-colors hover:border-primary/40">
                  <div className="lbl">Conf</div>
                  <div className="val text-xs">
                    {intel?.confidence != null ? `${(intel.confidence * 100).toFixed(0)}%` : '—'}
                  </div>
                </div>
                <div className="data-tile transition-colors hover:border-primary/40">
                  <div className="lbl">RSI</div>
                  <div className="val text-xs">{intel?.rsi?.toFixed?.(0) ?? '—'}</div>
                </div>
                <div className="data-tile transition-colors hover:border-primary/40">
                  <div className="lbl">Spot</div>
                  <div className="val text-xs">{intel?.price != null ? money(intel.price, 0) : '—'}</div>
                </div>
              </div>
              <TraceLadder label={`${asset.toUpperCase()} price-trace`} trace={trace} />
              {assetModels.length > 0 && (
                <div className="mt-1.5">
                  <div className="lbl mb-0.5">Individual models · hover for details</div>
                  <ModelPills models={assetModels} />
                </div>
              )}
              {conf && (
                <div className="mt-1.5 font-mono text-[0.6rem] text-muted-foreground">
                  Consensus {String(consensus?.direction || '—').toUpperCase()} · agr{' '}
                  {consensus?.agreementPct != null
                    ? `${Number(consensus.agreementPct).toFixed(0)}%`
                    : '—'}{' '}
                  · n={consensus?.sampleCount ?? conf.totalPredictions ?? conf.bufferSize ?? 0}
                </div>
              )}
              {intel?.thesis && (
                <p className="mt-1.5 border-l-2 border-primary/30 pl-2 text-xs leading-snug text-muted-foreground italic">
                  {intel.thesis}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
