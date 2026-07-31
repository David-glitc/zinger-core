// @ts-nocheck
import { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const ASSETS = ['btc', 'eth']
const WINDOWS = [
  { label: '5m', ticks: 120 },
  { label: '15m', ticks: 360 },
  { label: '30m', ticks: 720 },
  { label: '1h', ticks: 1440 },
]

const COLORS = {
  btc: { line: '#f59e0b', fill: 'rgba(245,158,11,0.16)', glow: 'rgba(245,158,11,0.45)', grid: 'rgba(255,255,255,0.08)' },
  eth: { line: '#60a5fa', fill: 'rgba(96,165,250,0.16)', glow: 'rgba(96,165,250,0.45)', grid: 'rgba(255,255,255,0.08)' },
}

function fmtPrice(v) {
  if (v == null) return '—'
  return '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function drawStepChart(ctx, data, xScale, yScale) {
  if (!data.length) return
  ctx.beginPath()
  for (let i = 0; i < data.length; i += 1) {
    const x = xScale(data[i].t)
    const y = yScale(data[i].price)
    if (i === 0) {
      ctx.moveTo(x, y)
      continue
    }
    const prevY = yScale(data[i - 1].price)
    ctx.lineTo(x, prevY)
    ctx.lineTo(x, y)
  }
}

function drawChart(canvas, data, color) {
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const w = rect.width
  const h = rect.height
  canvas.width = w * dpr
  canvas.height = h * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  if (!data || data.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '12px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.fillText('Waiting for spot data…', w / 2, h / 2)
    return
  }

  const pad = { top: 18, right: 68, bottom: 24, left: 12 }
  const chartW = w - pad.left - pad.right
  const chartH = h - pad.top - pad.bottom

  let minP = Infinity
  let maxP = -Infinity
  for (const p of data) {
    if (p.price < minP) minP = p.price
    if (p.price > maxP) maxP = p.price
  }
  const span = Math.max(maxP - minP, maxP * 0.0018)
  minP -= span * 0.12
  maxP += span * 0.12

  const t0 = data[0].t
  const t1 = data[data.length - 1].t || t0 + 1
  const xScale = (t) => pad.left + ((t - t0) / (t1 - t0 || 1)) * chartW
  const yScale = (v) => pad.top + (1 - (v - minP) / (maxP - minP || 1)) * chartH

  // Panel background
  ctx.fillStyle = 'rgba(8,8,10,0.88)'
  ctx.fillRect(pad.left, pad.top, chartW, chartH)

  // Grid + right-axis labels
  ctx.strokeStyle = color.grid
  ctx.lineWidth = 1
  ctx.font = '10px ui-monospace, monospace'
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.textAlign = 'left'
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (i / 4) * chartH
    const val = maxP - (i / 4) * (maxP - minP)
    ctx.beginPath()
    ctx.moveTo(pad.left, y)
    ctx.lineTo(w - pad.right, y)
    ctx.stroke()
    ctx.fillText(fmtPrice(val), w - pad.right + 6, y + 3)
  }

  // Area fill
  const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH)
  gradient.addColorStop(0, color.fill)
  gradient.addColorStop(1, 'rgba(0,0,0,0.01)')
  ctx.beginPath()
  ctx.moveTo(xScale(data[0].t), pad.top + chartH)
  for (let i = 0; i < data.length; i += 1) {
    const x = xScale(data[i].t)
    const y = yScale(data[i].price)
    if (i === 0) {
      ctx.lineTo(x, y)
      continue
    }
    const prevY = yScale(data[i - 1].price)
    ctx.lineTo(x, prevY)
    ctx.lineTo(x, y)
  }
  ctx.lineTo(xScale(data[data.length - 1].t), pad.top + chartH)
  ctx.closePath()
  ctx.fillStyle = gradient
  ctx.fill()

  // Line + glow
  ctx.save()
  ctx.shadowColor = color.glow
  ctx.shadowBlur = 8
  drawStepChart(ctx, data, xScale, yScale)
  ctx.strokeStyle = color.line
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.restore()

  // Last point marker + value
  const last = data[data.length - 1]
  if (last) {
    const lastX = xScale(last.t)
    const lastY = yScale(last.price)

    ctx.beginPath()
    ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2)
    ctx.fillStyle = color.line
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(lastX, pad.top)
    ctx.lineTo(lastX, pad.top + chartH)
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.setLineDash([3, 4])
    ctx.stroke()
    ctx.setLineDash([])

    ctx.font = 'bold 10px ui-monospace, monospace'
    ctx.textAlign = 'left'
    ctx.fillStyle = color.line
    ctx.fillText(fmtPrice(last.price), w - pad.right + 6, lastY + 3)
  }

  // Time labels
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.textAlign = 'left'
  ctx.fillText(new Date(t0).toLocaleTimeString(), pad.left, h - 6)
  ctx.textAlign = 'right'
  ctx.fillText(new Date(t1).toLocaleTimeString(), w - pad.right, h - 6)
}

export default function SpotChart({ className }) {
  const canvasRef = useRef(null)
  const [asset, setAsset] = useState('btc')
  const [window, setWindow] = useState(WINDOWS[0])
  const [history, setHistory] = useState({ btc: [], eth: [] })
  const [currentPrice, setCurrentPrice] = useState({ btc: null, eth: null })
  const [changePct, setChangePct] = useState({ btc: null, eth: null })
  const esRef = useRef(null)
  const animRef = useRef(null)

  useEffect(() => {
    WINDOWS.forEach(() => {})
    ASSETS.forEach(async (a) => {
      try {
        const res = await fetch(`/api/v1/charts/spot?asset=${a}&limit=${window.ticks}`)
        if (res.ok) {
          const data = await res.json()
          setHistory((prev) => ({ ...prev, [a]: data.ticks || [] }))
          if (data.current != null) setCurrentPrice((prev) => ({ ...prev, [a]: data.current }))
        }
      } catch {}
    })
  }, [window.ticks])

  useEffect(() => {
    if (esRef.current) esRef.current.close()
    const es = new EventSource('/api/v1/charts/spot/stream')
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.asset && data.tick && data.tick.price) {
          setCurrentPrice((prev) => ({ ...prev, [data.asset]: data.tick.price }))
          setHistory((prev) => {
            const buf = prev[data.asset] || []
            const next = [...buf, data.tick]
            if (next.length > window.ticks + 100) next.splice(0, next.length - window.ticks - 100)
            return { ...prev, [data.asset]: next }
          })
        } else if (data.ticks && data.asset) {
          setHistory((prev) => ({ ...prev, [data.asset]: data.ticks || [] }))
          if (data.current != null) setCurrentPrice((prev) => ({ ...prev, [data.asset]: data.current }))
        }
      } catch {}
    }
    return () => {
      es.close()
      esRef.current = null
    }
  }, [window.ticks])

  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const res = await fetch('/api/poly/state?lean=1')
        if (res.ok) {
          const data = await res.json()
          const spot = data.spotPrices || {}
          if (mounted) {
            if (spot.btc?.changePct != null) setChangePct((prev) => ({ ...prev, btc: spot.btc.changePct }))
            if (spot.eth?.changePct != null) setChangePct((prev) => ({ ...prev, eth: spot.eth.changePct }))
          }
        }
      } catch {}
      if (mounted) setTimeout(poll, 5000)
    }
    poll()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let running = true
    const loop = () => {
      if (!running) return
      drawChart(canvas, history[asset], COLORS[asset])
      animRef.current = requestAnimationFrame(loop)
    }
    loop()
    return () => {
      running = false
      if (animRef.current) cancelAnimationFrame(animRef.current)
    }
  }, [history, asset])

  const curr = currentPrice[asset]
  const chg = changePct[asset]
  const dir = chg != null ? (chg >= 0 ? 'up' : 'down') : null

  return (
    <Card className={cn('border-border/60 bg-card/90', className)}>
      <CardHeader className="flex flex-row items-center justify-between border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <CardTitle className="text-[0.65rem] font-semibold tracking-[0.14em] uppercase text-muted-foreground">Spot</CardTitle>
          <div className="flex gap-1">
            {ASSETS.map((a) => (
              <Button
                key={a}
                variant={asset === a ? 'default' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-[0.58rem] font-mono uppercase"
                onClick={() => setAsset(a)}
              >
                {a}
              </Button>
            ))}
          </div>
          <Badge variant="outline" className={cn('font-mono text-[0.58rem]', dir === 'up' && 'text-primary', dir === 'down' && 'text-destructive')}>
            {curr != null ? fmtPrice(curr) : '—'}
            {chg != null ? ` ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : ''}
          </Badge>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.label}
              variant={window.label === w.label ? 'secondary' : 'ghost'}
              size="sm"
              className="h-6 px-2 text-[0.55rem] font-mono"
              onClick={() => setWindow(w)}
            >
              {w.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <canvas ref={canvasRef} className="h-[210px] w-full" />
      </CardContent>
    </Card>
  )
}
