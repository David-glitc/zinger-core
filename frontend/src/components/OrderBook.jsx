import { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

function formatDepth(depth) {
  if (!depth) return null
  const bids = (depth.bids || []).map((b) => ({ ...b }))
  const asks = (depth.asks || []).map((a) => ({ ...a }))
  let cumBid = 0
  let cumAsk = 0
  for (const b of bids) {
    cumBid += b.size || 0
    b.cum = b.cum ?? cumBid
  }
  for (const a of asks) {
    cumAsk += a.size || 0
    a.cum = a.cum ?? cumAsk
  }
  const maxCum = Math.max(
    bids[bids.length - 1]?.cum || 0,
    asks[asks.length - 1]?.cum || 0,
    1,
  )
  return { ...depth, bids, asks, maxCum }
}

function SideRail({ side, onChange }) {
  return (
    <div className="mode-rail shrink-0" role="group" aria-label="Book side">
      <button type="button" data-mode="live" data-active={side === 'up'} onClick={() => onChange('up')}>UP buy</button>
      <button type="button" data-mode="paper" data-active={side === 'down'} onClick={() => onChange('down')}>DOWN buy</button>
    </div>
  )
}

export default function OrderBook({ tokenId, tokenIds, label, initialDepth, defaultSide = 'up', onClose }) {
  const [side, setSide] = useState(defaultSide)
  const activeTokenId = tokenIds?.[side] || tokenId
  const seed = initialDepth?.[side] || null
  const [depth, setDepth] = useState(() => formatDepth(seed))
  const [loading, setLoading] = useState(!seed)

  useEffect(() => { setSide(defaultSide) }, [defaultSide, tokenIds?.up, tokenIds?.down, tokenId])
  useEffect(() => { if (initialDepth?.[side]) setDepth(formatDepth(initialDepth[side])) }, [initialDepth, side])

  useEffect(() => {
    if (!activeTokenId) return
    let cancelled = false
    setLoading(true)
    const pull = () =>
      fetch(`/api/poly/depth?tokenId=${encodeURIComponent(activeTokenId)}`)
        .then((r) => r.json())
        .then((d) => { if (!cancelled && (d?.bids || d?.asks)) setDepth(formatDepth(d)) })
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoading(false) })
    pull()
    const id = setInterval(pull, 2000)
    return () => { cancelled = true; clearInterval(id) }
  }, [activeTokenId])

  if (!activeTokenId && !seed) return null

  const d = depth
  const sideLabel = side === 'up' ? 'UP' : 'DOWN'

  return (
    <Card className="border-border/60 bg-card/80 backdrop-blur-sm">
      <CardHeader className="border-border/60 flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <CardTitle className="text-xs font-semibold tracking-wider uppercase">
            Order book{label ? ` · ${label}` : ''} · {sideLabel}
          </CardTitle>
          {tokenIds?.up && tokenIds?.down && <SideRail side={side} onChange={setSide} />}
        </div>
        {d && (
          <div className="flex flex-wrap items-center gap-1.5 text-[0.6rem]">
            <Badge variant="outline" className={cn('px-1.5 py-0.5 text-[0.55rem]', (d.spreadPct ?? 99) < 1 ? 'border-primary/30 text-primary' : 'border-destructive/30 text-destructive')}>
              Spread {(d.spreadPct ?? 0).toFixed(2)}%
            </Badge>
            <Badge variant="outline" className={cn('px-1.5 py-0.5 text-[0.55rem]', d.imbalance > 0.2 ? 'border-primary/30 text-primary' : d.imbalance < -0.2 ? 'border-destructive/30 text-destructive' : 'text-muted-foreground border-border/60')}>
              {d.imbalance > 0 ? 'BID+' : d.imbalance < 0 ? 'ASK+' : 'FLAT'}
            </Badge>
            {onClose && (
              <button type="button" className="text-muted-foreground hover:text-foreground ml-1 text-xs" onClick={onClose}>close</button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {loading && !d && <div className="text-muted-foreground py-6 text-center text-xs">Loading depth…</div>}
        {!loading && !d && <div className="text-muted-foreground py-6 text-center text-xs">No order book</div>}
        {d && (
          <div className="font-mono text-[0.6rem]">
            <div className="text-muted-foreground border-border/40 grid grid-cols-[4.5rem_3.5rem_3.5rem_1fr] gap-1 border-b px-3 py-1.5 text-[0.55rem] tracking-wider uppercase">
              <span>Price</span>
              <span className="text-right">Size</span>
              <span className="text-right">Total</span>
              <span className="text-right">Side</span>
            </div>
            <ScrollArea className="h-[220px]">
              {[...(d.asks || [])].reverse().map((a, i) => (
                <div key={`a${i}`} className="hover:bg-muted/30 relative grid grid-cols-[4.5rem_3.5rem_3.5rem_1fr] items-center gap-1 px-3 py-px">
                  <div className="bg-destructive/10 absolute top-0 right-0 bottom-0" style={{ width: `${((a.cum || 0) / d.maxCum) * 100}%` }} />
                  <span className="text-destructive/90 z-10">{Number(a.price).toFixed(3)}</span>
                  <span className="text-muted-foreground z-10 text-right">{Number(a.size).toFixed(1)}</span>
                  <span className="text-muted-foreground z-10 text-right">{Number(a.cum || 0).toFixed(0)}</span>
                  <span className="text-destructive/80 z-10 text-right uppercase">sell</span>
                </div>
              ))}
              {(d.bestBid > 0 || d.bestAsk > 0) && (
                <div className="text-muted-foreground border-border/30 bg-muted/20 grid grid-cols-[4.5rem_3.5rem_3.5rem_1fr] gap-1 border-y px-3 py-1.5 text-[0.55rem]">
                  <span>{d.mid != null ? Number(d.mid).toFixed(3) : '—'}</span>
                  <span className="text-right">mid</span>
                  <span className="text-right">{d.spread != null ? `$${(Number(d.spread) * 100).toFixed(1)}¢` : '—'}</span>
                  <span className="text-right">{d.bidCount || 0}/{d.askCount || 0} lvls</span>
                </div>
              )}
              {(d.bids || []).map((b, i) => (
                <div key={`b${i}`} className="hover:bg-muted/30 relative grid grid-cols-[4.5rem_3.5rem_3.5rem_1fr] items-center gap-1 px-3 py-px">
                  <div className="bg-primary/10 absolute top-0 right-0 bottom-0" style={{ width: `${((b.cum || 0) / d.maxCum) * 100}%` }} />
                  <span className="text-primary/90 z-10">{Number(b.price).toFixed(3)}</span>
                  <span className="text-muted-foreground z-10 text-right">{Number(b.size).toFixed(1)}</span>
                  <span className="text-muted-foreground z-10 text-right">{Number(b.cum || 0).toFixed(0)}</span>
                  <span className="text-primary/80 z-10 text-right uppercase">buy</span>
                </div>
              ))}
            </ScrollArea>
            <div className="text-muted-foreground border-border/40 flex flex-wrap items-center gap-3 border-t px-3 py-2 text-[0.55rem]">
              <span>Bid ${Number(d.totalBidVol || d.bidVol || 0).toFixed(0)}</span>
              <Separator orientation="vertical" className="h-3" />
              <span>Ask ${Number(d.totalAskVol || d.askVol || 0).toFixed(0)}</span>
              <Separator orientation="vertical" className="h-3" />
              <span className={cn(d.imbalance > 0 ? 'text-primary' : d.imbalance < 0 ? 'text-destructive' : '')}>
                Imb {((d.imbalance || 0) * 100).toFixed(0)}%
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}