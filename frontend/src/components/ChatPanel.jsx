import { useState, useRef, useEffect, useMemo } from 'react'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { fmtTimeMs } from '@/polyTimers'

const LOG_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'buy', label: 'Buy' },
  { id: 'sell', label: 'Sell' },
  { id: 'signal', label: 'Signal' },
  { id: 'system', label: 'Sys' },
  { id: 'error', label: 'Err' },
]

function matchesFilter(type, filter) {
  if (filter === 'all') return true
  const t = (type || 'info').toLowerCase()
  if (filter === 'buy') return t === 'buy' || t === 'tp' || t === 'announce'
  if (filter === 'sell') return t === 'sell' || t === 'sl' || t === 'panic'
  if (filter === 'signal') return t === 'signal' || t === 'ml'
  if (filter === 'system') return t === 'system' || t === 'info' || t === 'log'
  if (filter === 'error') return t === 'error' || t === 'warn'
  return t === filter
}

function typeTone(type) {
  if (type === 'error' || type === 'sl' || type === 'sell') return 'text-destructive'
  if (type === 'buy' || type === 'tp' || type === 'announce') return 'text-primary'
  if (type === 'signal' || type === 'system') return 'text-primary'
  return 'text-muted-foreground'
}

function typeBadge(type) {
  if (type === 'buy' || type === 'tp') return 'bg-primary/15 text-primary border-primary/30'
  if (type === 'sl' || type === 'error' || type === 'sell') return 'bg-destructive/15 text-destructive border-destructive/30'
  if (type === 'announce' || type === 'signal') return 'bg-primary/15 text-primary border-primary/30'
  return 'bg-muted text-muted-foreground border-border'
}

export default function ChatPanel({ actions, trades, positions, signals, poly }) {
  const [tab, setTab] = useState('log')
  const [logFilter, setLogFilter] = useState('all')
  const [question, setQuestion] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [messages, setMessages] = useState([])
  const scrollRef = useRef(null)

  const feed = useMemo(() => {
    const fromActions = Array.isArray(actions) ? actions : []
    const fromExec = Array.isArray(poly?.executionLog) ? poly.executionLog : []
    const merged = [...fromActions]
    const seen = new Set(fromActions.map((a) => `${a.time}|${a.msg}`))
    for (const e of fromExec) {
      const key = `${e.time}|${e.msg}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(e)
    }
    return merged
      .filter((a) => a && a.msg && a.type !== 'scan')
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .slice(0, 200)
  }, [actions, poly?.executionLog])

  const filteredFeed = useMemo(
    () => feed.filter((a) => matchesFilter(a.type, logFilter)),
    [feed, logFilter],
  )

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [filteredFeed.length, tab, logFilter, messages.length])

  const openPositions = (positions || []).filter((p) => !p.closed)
  const doneTrades = (trades || []).slice(0, 30)
  const llmConfigured = poly?.llm?.configured !== false

  const ask = async (q) => {
    const text = (q || question).trim()
    if (!text || chatBusy) return
    setChatBusy(true)
    setMessages((m) => [...m, { role: 'user', text, t: Date.now() }])
    setQuestion('')
    try {
      const r = await fetch('/api/poly/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text }),
      })
      const d = await r.json()
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: d.answer || d.error || 'No reply',
          model: d.model,
          ok: d.ok !== false && !d.error,
          t: Date.now(),
        },
      ])
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: e.message, ok: false, t: Date.now() }])
    } finally {
      setChatBusy(false)
    }
  }

  const brief = async () => {
    setChatBusy(true)
    try {
      const r = await fetch('/api/poly/brief')
      const d = await r.json()
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: d.text || d.error || 'Brief failed',
          model: d.model,
          ok: Boolean(d.text),
          t: Date.now(),
        },
      ])
      setTab('ai')
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: e.message, ok: false, t: Date.now() }])
    } finally {
      setChatBusy(false)
    }
  }

  return (
    <Card className="chat-panel flex h-full min-h-[28rem] flex-col gap-0 border-border/60 bg-card/80 py-0 shadow-none backdrop-blur-sm">
      <CardHeader className="border-border/60 flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <CardTitle className="text-xs font-semibold tracking-wider uppercase">Feed / AI</CardTitle>
          <Badge variant="outline" className="font-mono text-[0.6rem]">
            {tab === 'log' ? filteredFeed.length : tab === 'ai' ? messages.length : feed.length}
          </Badge>
          {poly?.llm?.configured === false && (
            <Badge variant="destructive" className="font-mono text-[0.55rem]">
              LLM off
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-1 sm:ml-auto">
          {['log', 'ai', 'trades', 'open', 'signals'].map((t) => (
            <button
              key={t}
              type="button"
              className={cn(
                'min-h-8 rounded px-2.5 py-1 text-[0.65rem] font-medium transition-colors',
                tab === t ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setTab(t)}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </CardHeader>

      {tab === 'log' && (
        <div className="border-border/50 flex gap-1 overflow-x-auto border-b px-2 py-1.5">
          {LOG_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setLogFilter(f.id)}
              className={cn(
                'shrink-0 rounded-md border px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wide transition-colors',
                logFilter === f.id
                  ? 'border-primary/40 bg-primary/15 text-primary'
                  : 'border-border/60 text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      <CardContent className="min-h-0 flex-1 p-0">
        <ScrollArea className="h-[min(48dvh,380px)]" ref={scrollRef}>
          {tab === 'log' && (
            <div className="space-y-0.5 p-1.5">
              {filteredFeed.length === 0 ? (
                <div className="text-muted-foreground py-6 text-center text-xs">
                  {feed.length === 0 ? 'Waiting for scans / fills' : `No ${logFilter} events`}
                </div>
              ) : (
                filteredFeed.map((a, i) => (
                  <div
                    key={`${a.time}-${i}`}
                    className="hover:bg-muted/40 flex gap-1.5 rounded border border-transparent px-1.5 py-1 text-xs leading-snug"
                  >
                    <span className="text-muted-foreground w-[64px] shrink-0 font-mono text-[0.55rem] opacity-70">
                      {fmtTimeMs(a.time)}
                    </span>
                    <Badge variant="outline" className={cn('h-5 shrink-0 px-1 py-0 text-[0.5rem]', typeBadge(a.type))}>
                      {(a.type || 'log').toUpperCase()}
                    </Badge>
                    <span className={cn('min-w-0 flex-1 break-words', typeTone(a.type))}>{a.msg}</span>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'ai' && (
            <div className="space-y-2 p-2">
              {messages.length === 0 ? (
                <div className="text-muted-foreground space-y-2 py-6 text-center text-xs">
                  <p>Ask about PnL, positions, signals, or scan blocks.</p>
                  <Button size="sm" variant="outline" disabled={chatBusy} onClick={brief}>
                    Generate briefing
                  </Button>
                </div>
              ) : (
                messages.map((m, i) => (
                  <div
                    key={i}
                    className={cn(
                      'rounded-lg border px-2.5 py-2 text-xs leading-relaxed',
                      m.role === 'user'
                        ? 'border-primary/30 bg-primary/10 ml-6'
                        : 'border-border/60 bg-muted/30 mr-4',
                    )}
                  >
                    <div className="text-muted-foreground mb-1 font-mono text-[0.55rem] uppercase">
                      {m.role === 'user' ? 'you' : m.model || 'zinger'}
                    </div>
                    <div className={cn(!m.ok && m.role === 'assistant' && 'text-destructive')}>{m.text}</div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'trades' && (
            <div className="space-y-1 p-1.5">
              {doneTrades.length === 0 ? (
                <div className="text-muted-foreground py-6 text-center text-xs">No trades yet</div>
              ) : (
                doneTrades.map((t, i) => (
                  <div key={i} className="hover:bg-muted/40 rounded border border-border/50 px-2.5 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{t.symbol}</span>
                      <Badge variant={t.outcome === 'up' ? 'default' : 'secondary'} className="px-1.5 py-0.5 text-[0.55rem]">
                        {t.outcome?.toUpperCase()}
                      </Badge>
                      <span className={cn('ml-auto font-mono', (t.pnl || 0) >= 0 ? 'text-primary' : 'text-destructive')}>
                        {(t.pnl || 0) >= 0 ? '+' : ''}${(t.pnl || 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'open' && (
            <div className="space-y-1 p-1.5">
              {openPositions.length === 0 ? (
                <div className="text-muted-foreground py-6 text-center text-xs">No open positions</div>
              ) : (
                openPositions.map((p, i) => (
                  <div key={i} className="rounded border border-border/50 px-2.5 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{p.symbol || (p.title || '').slice(0, 16)}</span>
                      <Badge className="px-1.5 py-0.5 text-[0.55rem]">{(p.outcome || '').toString().toUpperCase()}</Badge>
                      <span className="text-muted-foreground font-mono text-[0.6rem]">
                        {Number(p.entryPrice || 0).toFixed(3)}→{Number(p.liveMark || p.currentPrice || 0).toFixed(3)}
                      </span>
                      <span className={cn('ml-auto font-mono', (p.pnl || p.cashPnl || 0) >= 0 ? 'text-primary' : 'text-destructive')}>
                        {((p.pnl ?? p.cashPnl) || 0) >= 0 ? '+' : ''}${Number(p.pnl ?? p.cashPnl ?? 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'signals' && (
            <div className="space-y-1 p-1.5">
              {['btc', 'eth'].map((asset) => {
                const s = signals?.[asset] || poly?.intelligence?.[asset]
                const spot = poly?.spotPrices?.[asset]
                return (
                  <div key={asset} className="rounded bg-muted/30 px-2.5 py-1.5 text-xs">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-semibold">{asset.toUpperCase()}</span>
                      {spot?.price != null && (
                        <span className="font-mono text-primary">
                          ${Number(spot.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      )}
                      {s?.direction && (
                        <span className={cn('ml-auto font-mono', s.direction === 'up' ? 'text-primary' : 'text-destructive')}>
                          {s.direction?.toUpperCase()} {((s.confidence || 0) * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </CardContent>

      {tab === 'ai' && (
        <div className="border-border/60 flex gap-1.5 border-t p-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={llmConfigured ? 'Ask Zinger…' : 'Set OPENROUTER_API_KEY'}
            className="h-9 text-xs"
            disabled={chatBusy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') ask()
            }}
          />
          <Button size="sm" className="h-9" disabled={chatBusy || !question.trim()} onClick={() => ask()}>
            Ask
          </Button>
        </div>
      )}

      <CardFooter className="border-border/60 border-t px-3 py-1.5">
        <div className="text-muted-foreground flex w-full items-center gap-2 text-[0.65rem]">
          <span
            className={cn(
              'inline-block size-2 rounded-full',
              poly?.running ? 'bg-primary shadow-[0_0_6px] shadow-primary' : 'bg-muted-foreground',
            )}
          />
          <span className={poly?.running ? 'text-primary' : ''}>{poly?.running ? 'ENGAGED' : 'STOPPED'}</span>
          <Separator orientation="vertical" className="h-3" />
          <span>Net ${Number(poly?.portfolio?.netPnl || 0).toFixed(2)}</span>
          <Separator orientation="vertical" className="h-3" />
          <span>{openPositions.length} open</span>
        </div>
      </CardFooter>
    </Card>
  )
}
