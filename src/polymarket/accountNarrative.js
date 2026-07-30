/**
 * Real-time NLP-ish narrative of what the bot / feeds are doing right now.
 * Purely deterministic template language from live state — no LLM required.
 */
export function buildSystemNarrative(state = {}) {
  const mode = state.mode || state.config?.mode || 'paper'
  const running = !!state.running
  const markets = (state.markets || []).filter((m) => m.isCurrent)
  const opens = (state.botPositions || state.positions || []).filter((p) => !p.closed)
  const actions = state.actions || []
  const last = actions[0]
  const signals = state.signals || {}
  const clobWs = state.clobWs || {}
  const audit = state.cashAudit || state.audit || {}
  const liveAccount = state.liveAccount || {}
  const assurance = state.dataAssurance || {}
  const edge = state.edgeGate || {}

  const lines = []
  const now = Date.now()

  // Headline
  if (!running) {
    lines.push({
      tone: 'idle',
      text: `Core is idle in ${String(mode).toUpperCase()} — feeds still refresh, no new entries.`,
    })
  } else {
    lines.push({
      tone: 'live',
      text: `Bot is RUNNING in ${String(mode).toUpperCase()} · scanning BTC/ETH windows and managing exits.`,
    })
  }

  // Markets / books
  if (markets.length) {
    const bits = markets.map((m) => {
      const up = m.prices?.up
      const down = m.prices?.down
      const rem = m.remaining != null ? `${m.remaining}s left` : ''
      const src = m.priceSource || m.prices?._source || '?'
      const act = m.action || m.decision?.action || 'watch'
      return `${m.symbol} ${String(act).toUpperCase()} UP ${up != null ? Number(up).toFixed(2) : '—'} / DOWN ${down != null ? Number(down).toFixed(2) : '—'} (${src}${rem ? `, ${rem}` : ''})`
    })
    lines.push({ tone: 'market', text: `Books: ${bits.join(' · ')}` })
  } else {
    lines.push({ tone: 'warn', text: 'No current market books yet — waiting on Gamma/CLOB discovery.' })
  }

  // Signals / ML
  for (const asset of ['btc', 'eth']) {
    const s = signals[asset]
    if (!s) continue
    const age = s.timestamp ? Math.max(0, Math.round((now - s.timestamp) / 1000)) : null
    lines.push({
      tone: 'signal',
      text: `${asset.toUpperCase()} signal ${String(s.direction || '?').toUpperCase()} · conf ${(Number(s.confidence || 0) * 100).toFixed(0)}%${age != null ? ` · ${age}s ago` : ''}`,
    })
  }
  const ml = state.mlTraces || {}
  for (const asset of ['btc', 'eth']) {
    const t = ml[asset]
    if (!t || t.error) continue
    // Support both getPriceTrace ({prices}) and full ML ladder ({priceTrace,direction})
    const ladder = t.priceTrace || t.prices || []
    let dir = t.direction
    if (dir == null && ladder.length) {
      const ups = ladder.filter((p) => String(p.direction).toLowerCase() === 'up').length
      const dns = ladder.filter((p) => String(p.direction).toLowerCase() === 'down').length
      dir = ups === dns ? 0 : ups > dns ? 1 : -1
    }
    const dirLabel = dir === 1 || dir === 'up' ? 'UP' : dir === -1 || dir === 'down' ? 'DOWN' : 'FLAT'
    const conf = t.confidence != null
      ? Number(t.confidence)
      : ladder.length
        ? ladder.reduce((s, p) => s + Number(p.confidence || 0), 0) / ladder.length
        : 0
    lines.push({
      tone: 'ml',
      text: `${asset.toUpperCase()} ML ladder ${dirLabel} · conf ${(conf * 100).toFixed(0)}% · ${ladder.length} horizons${t.marketDuration ? ` · book ${t.marketDuration}` : ''}`,
    })
  }

  // CLOB WS / depth
  if (clobWs.connected) {
    lines.push({
      tone: 'clob',
      text: `CLOB WebSocket live · ${clobWs.books || 0} books · ${clobWs.subscribed || 0} subscribed · last msg ${clobWs.lastMsgAgeMs != null ? `${clobWs.lastMsgAgeMs}ms` : '—'} ago`,
    })
  } else if (clobWs.running) {
    lines.push({ tone: 'warn', text: 'CLOB WebSocket reconnecting…' })
  }

  // Positions
  if (opens.length) {
    const bits = opens.slice(0, 4).map((p) => {
      const g = Number(p.gainPct || 0)
      return `${p.symbol} ${String(p.outcome || '').toUpperCase()} ${g >= 0 ? '+' : ''}${g.toFixed(1)}% (${p.mode || mode})`
    })
    lines.push({ tone: 'pos', text: `Open ${opens.length}: ${bits.join(' · ')}` })
  } else {
    lines.push({ tone: 'pos', text: 'No open bot positions — waiting for the next eligible entry.' })
  }

  // Last action
  if (last) {
    const age = last.timestamp ? Math.max(0, Math.round((now - last.timestamp) / 1000)) : null
    lines.push({
      tone: 'action',
      text: `Latest: ${last.message || last.type || 'event'}${age != null ? ` (${age}s ago)` : ''}`,
    })
  }

  // Edge / assurance / audit
  if (edge.reason) {
    lines.push({
      tone: edge.liveAllowed ? 'ok' : 'warn',
      text: `Edge gate: ${edge.reason}${edge.expectancy != null ? ` · E$${edge.expectancy}` : ''}`,
    })
  }
  if (assurance.blocking?.length) {
    lines.push({
      tone: 'warn',
      text: `Data assurance blocking: ${assurance.blocking.join(', ')}`,
    })
  } else if (assurance.ok) {
    lines.push({ tone: 'ok', text: 'Data assurance clear — buys allowed when bands match.' })
  }
  if (audit.ok === false && (audit.issues || []).length) {
    lines.push({
      tone: 'warn',
      text: `Account audit: ${(audit.issues || []).slice(0, 2).join('; ')}`,
    })
  } else if (audit.ok) {
    lines.push({ tone: 'ok', text: 'Account audit clean.' })
  }

  // Live PM truth
  const pmSum = liveAccount.totals?.pmRealizedSum
  if (pmSum != null) {
    lines.push({
      tone: Number(pmSum) >= 0 ? 'ok' : 'warn',
      text: `Polymarket closed-book realized $${Number(pmSum).toFixed(2)} · CLOB cash $${Number(liveAccount.cash?.clob ?? 0).toFixed(2)}`,
    })
  }

  const headline = lines[0]?.text || 'System status unknown'
  return {
    at: now,
    mode,
    running,
    headline,
    lines,
    // Flat paragraph for TTS / copy
    paragraph: lines.map((l) => l.text).join(' '),
  }
}

/** Compact carousel chips for the live score strip */
export function buildLiveScoreCards(state = {}) {
  const cards = []
  const markets = (state.markets || []).filter((m) => m.isCurrent)
  const opens = (state.botPositions || state.positions || []).filter((p) => !p.closed)
  const actions = (state.actions || []).slice(0, 8)
  const signals = state.signals || {}
  const clobWs = state.clobWs || {}
  const ml = state.mlTraces || {}

  for (const m of markets) {
    cards.push({
      id: `mkt-${m.slug}`,
      kind: 'market',
      title: `${m.symbol} ${m.duration || '5m'}`,
      value: m.action || m.decision?.action || 'watch',
      detail: `UP ${m.prices?.up != null ? Number(m.prices.up).toFixed(2) : '—'} · ${m.priceSource || m.prices?._source || '?'}`,
      tone: String(m.action || '').includes('buy') ? 'up' : 'muted',
    })
    if (m.depth?.up || m.book?.up) {
      const d = m.depth?.up || m.book?.up
      cards.push({
        id: `depth-${m.slug}-up`,
        kind: 'depth',
        title: `${m.symbol} UP book`,
        value: d.mid != null ? Number(d.mid).toFixed(3) : '—',
        detail: `bid ${d.bestBid ?? '—'} / ask ${d.bestAsk ?? '—'}`,
        tone: 'clob',
      })
    }
  }

  for (const asset of ['btc', 'eth']) {
    const s = signals[asset]
    if (s) {
      cards.push({
        id: `sig-${asset}`,
        kind: 'signal',
        title: `${asset.toUpperCase()} signal`,
        value: String(s.direction || '?').toUpperCase(),
        detail: `conf ${((s.confidence || 0) * 100).toFixed(0)}%`,
        tone: s.direction === 'up' ? 'up' : s.direction === 'down' ? 'down' : 'muted',
      })
    }
    const t = ml[asset]
    if (t && !t.error) {
      const ladder = t.priceTrace || t.prices || []
      let dir = t.direction
      if (dir == null && ladder.length) {
        const ups = ladder.filter((p) => String(p.direction).toLowerCase() === 'up').length
        const dns = ladder.filter((p) => String(p.direction).toLowerCase() === 'down').length
        dir = ups === dns ? 0 : ups > dns ? 1 : -1
      }
      const dirLabel = dir === 1 || dir === 'up' ? 'UP' : dir === -1 || dir === 'down' ? 'DOWN' : 'FLAT'
      const conf = t.confidence != null
        ? Number(t.confidence)
        : ladder.length
          ? ladder.reduce((s, p) => s + Number(p.confidence || 0), 0) / ladder.length
          : 0
      cards.push({
        id: `ml-${asset}`,
        kind: 'ml',
        title: `${asset.toUpperCase()} ML`,
        value: dirLabel,
        detail: `${ladder.length} horizons · ${(conf * 100).toFixed(0)}%`,
        tone: dirLabel === 'UP' ? 'up' : dirLabel === 'DOWN' ? 'down' : 'muted',
      })
    }
  }

  cards.push({
    id: 'clob-ws',
    kind: 'clob',
    title: 'CLOB WS',
    value: clobWs.connected ? 'LIVE' : 'OFF',
    detail: `${clobWs.books || 0} books · age ${clobWs.lastMsgAgeMs ?? '—'}ms`,
    tone: clobWs.connected ? 'up' : 'down',
  })

  for (const p of opens.slice(0, 4)) {
    const g = Number(p.gainPct || 0)
    cards.push({
      id: `pos-${p.id}`,
      kind: 'position',
      title: `${p.symbol} ${String(p.outcome || '').toUpperCase()}`,
      value: `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`,
      detail: `entry ${p.entryPrice} · ${p.mode || ''}`,
      tone: g >= 0 ? 'up' : 'down',
    })
  }

  for (const a of actions.slice(0, 6)) {
    cards.push({
      id: `act-${a.id || a.timestamp}`,
      kind: 'action',
      title: a.type || 'event',
      value: (a.message || '').slice(0, 42),
      detail: a.timestamp ? new Date(a.timestamp).toLocaleTimeString() : '',
      tone: /tp|buy|win/i.test(String(a.type) + String(a.message))
        ? 'up'
        : /sl|error|reject/i.test(String(a.type) + String(a.message))
          ? 'down'
          : 'muted',
    })
  }

  // Inference / scan heartbeat
  const lastScan = state.lastScan || state.lastScanLog || null
  if (lastScan) {
    const age = lastScan.at || lastScan.timestamp
      ? Math.max(0, Math.round((Date.now() - Number(lastScan.at || lastScan.timestamp)) / 1000))
      : null
    cards.push({
      id: 'inference-scan',
      kind: 'inference',
      title: 'Scan pulse',
      value: lastScan.action || lastScan.result || lastScan.status || 'tick',
      detail: `${lastScan.markets ?? lastScan.scanned ?? '—'} mkts${age != null ? ` · ${age}s ago` : ''}`,
      tone: 'clob',
    })
  }
  const edge = state.edgeGate || {}
  if (edge.reason) {
    cards.push({
      id: 'edge-gate',
      kind: 'inference',
      title: 'Edge gate',
      value: edge.liveAllowed ? 'OPEN' : 'HOLD',
      detail: String(edge.reason).slice(0, 48),
      tone: edge.liveAllowed ? 'up' : 'muted',
    })
  }

  return cards.slice(0, 28)
}
