// @ts-nocheck
import { useEffect, useRef, useState } from 'react'
import { LiveCountdown, LiveClock, useLiveTick, CLOCK_TICK_MS } from '../polyTimers'
import { cn } from '@/lib/utils'

function useFlashPrice(price) {
  const prev = useRef(price)
  const [flash, setFlash] = useState(null)
  useEffect(() => {
    if (price == null || prev.current == null || price === prev.current) {
      prev.current = price
      return
    }
    const dir = price > prev.current ? 'up' : 'down'
    prev.current = price
    setFlash(dir)
    const id = setTimeout(() => setFlash(null), 220)
    return () => clearTimeout(id)
  }, [price])
  return flash
}

function TickCell({ label, price, digits = 2, changePct, className, children }) {
  const flash = useFlashPrice(price)
  const fmt =
    price == null
      ? '—'
      : typeof price === 'string'
        ? price
        : `$${Number(price).toLocaleString(undefined, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          })}`
  return (
    <div className={cn('live-tick', className)}>
      <div className="sym">{label}</div>
      {children || (
        <div className={cn('px', flash === 'up' && 'flash-up', flash === 'down' && 'flash-down')}>
          {fmt}
        </div>
      )}
      {changePct != null && Number.isFinite(Number(changePct)) && (
        <div className={cn('chg', Number(changePct) >= 0 ? 'up' : 'down')}>
          {Number(changePct) >= 0 ? '+' : ''}
          {Number(changePct).toFixed(2)}%
        </div>
      )}
    </div>
  )
}

function ScoreCard({ card }) {
  return (
    <div className={cn('live-score-card', card.tone || 'muted')}>
      <div className="kind">{card.kind}</div>
      <div className="title">{card.title}</div>
      <div className="value">{card.value}</div>
      {card.detail && <div className="detail">{card.detail}</div>}
    </div>
  )
}

/**
 * Aggressive live tape + score-strip carousel (actions / ML / CLOB / depth).
 */
export default function LiveTickStrip({ poly }) {
  useLiveTick(CLOCK_TICK_MS)
  const spots = poly?.spotPrices || {}
  const markets = (poly?.markets || []).filter((m) => m.isCurrent && m.prices)
  const cycle = poly?.cycle || {}
  const running = !!poly?.running
  const cards = poly?.liveScoreCards || []
  const headline = poly?.narrative?.headline

  return (
    <div className="live-tick-wrap">
      {headline && (
        <div className="live-nlp-bar" title={poly?.narrative?.paragraph || headline}>
          <span className="nlp-tag">NOW</span>
          <span className="nlp-text">{headline}</span>
        </div>
      )}
      <div className="live-tick-strip" aria-label="Live market ticks">
        <TickCell
          label="BTC"
          price={spots.btc?.price}
          digits={0}
          changePct={spots.btc?.changePct}
        />
        <TickCell
          label="ETH"
          price={spots.eth?.price}
          digits={2}
          changePct={spots.eth?.changePct}
        />
        <div className="live-tick cycle">
          <div className="sym">Window left · {cycle.class || 'OPEN'}</div>
          <div className="px">
            <LiveCountdown
              endAtMs={cycle.endAtMs}
              fallbackMs={cycle.remainingMs}
              fallbackSeconds={cycle.remainingSeconds}
            />
          </div>
          <div className="chg up">{running ? 'ENGAGED' : 'HOLD'}</div>
        </div>
        {markets.slice(0, 4).map((m) => (
          <TickCell
            key={`${m.slug}-up`}
            label={`${m.symbol} UP`}
            price={m.prices?.up}
            digits={3}
          />
        ))}
        {markets.slice(0, 4).map((m) => (
          <TickCell
            key={`${m.slug}-dn`}
            label={`${m.symbol} DN`}
            price={m.prices?.down}
            digits={3}
          />
        ))}
        <div className="live-tick-live">
          <span className="dot" aria-hidden />
          LIVE <LiveClock />
        </div>
      </div>
      {cards.length > 0 && (
        <div className="live-score-strip" aria-label="Live score carousel">
          <div className="live-score-track">
            {[...cards, ...cards].map((card, i) => (
              <ScoreCard key={`${card.id}-${i}`} card={card} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
