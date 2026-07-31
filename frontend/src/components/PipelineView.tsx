// @ts-nocheck
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export default function PipelineView() {
  const [rlData, setRlData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    function fetchRL() {
      fetch('/api/poly/rl-signal?symbol=BTC')
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return
          setRlData(d)
          setError(null)
        })
        .catch((e) => {
          if (!alive) return
          setError(e.message)
        })
    }
    fetchRL()
    const timer = setInterval(fetchRL, 30000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const dirLabel = { '-1': 'DOWN', '0': 'NEUTRAL', '1': 'UP' }
  const rl = rlData || {}

  return (
    <div className="pipeline-host rounded-lg border border-border/70 bg-card/80 p-2.5 min-h-[7.5rem]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-mono text-[0.6rem] tracking-[0.16em] text-primary uppercase">Pipeline</div>
        <span className="text-muted-foreground font-mono text-[0.55rem]">
          {error ? 'offline' : `${rl.model_count || (rl.models || []).length || 0} models`}
        </span>
      </div>
      {!rlData && !error ? (
        <div className="text-muted-foreground text-xs">loading…</div>
      ) : error ? (
        <div className="text-muted-foreground text-xs">RL fuser offline</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            {[
              { label: 'RL Fuser', dir: rl.rl_direction, conf: rl.rl_confidence },
              { label: 'Rules', dir: rl.rule_direction, conf: rl.rl_confidence },
              {
                label: 'Decision',
                dir: rl.rl_direction === rl.rule_direction ? 1 : -1,
                text: rl.rl_direction === rl.rule_direction ? 'MATCH' : 'CONFLICT',
              },
            ].map((s) => (
              <div key={s.label} className="rounded border border-border/60 bg-background/40 px-1.5 py-1 text-center">
                <div className="text-muted-foreground text-[0.55rem] uppercase">{s.label}</div>
                <div
                  className={cn(
                    'font-mono text-xs font-bold',
                    s.dir === 1 && 'text-primary',
                    s.dir === -1 && 'text-destructive',
                  )}
                >
                  {s.text || dirLabel[String(s.dir)] || '—'}
                </div>
                {s.conf != null && (
                  <div className="text-muted-foreground font-mono text-[0.55rem]">
                    {(Number(s.conf) * 100).toFixed(0)}%
                  </div>
                )}
              </div>
            ))}
          </div>
          {(rl.models || []).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {rl.models.slice(0, 8).map((m, i) => (
                <span
                  key={i}
                  className={cn(
                    'rounded border px-1 py-0.5 font-mono text-[0.55rem]',
                    m.direction === 1
                      ? 'border-primary/30 text-primary'
                      : m.direction === -1
                        ? 'border-destructive/30 text-destructive'
                        : 'border-border text-muted-foreground',
                  )}
                >
                  {m.timeframe}h{m.horizon} {dirLabel[String(m.direction)]}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
