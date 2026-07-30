import { useCallback, useEffect, useRef, useState } from 'react'
import { Minus, Plus, Maximize2, Hand, Crosshair, GripVertical, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const DEFAULT_NODES = [
  { id: 'spot', label: 'SPOT FEED', sub: 'Binance BTC/ETH', x: 80, y: 120, w: 168, h: 72 },
  { id: 'gamma', label: 'GAMMA', sub: '5m / 15m windows', x: 80, y: 260, w: 168, h: 72 },
  { id: 'clob', label: 'CLOB DEPTH', sub: 'UP/DOWN books', x: 80, y: 400, w: 168, h: 72 },
  { id: 'btc-models', label: 'BTC MODELS', sub: '6 horizons', x: 340, y: 40, w: 210, h: 148 },
  { id: 'eth-models', label: 'ETH MODELS', sub: '6 horizons', x: 340, y: 210, w: 210, h: 148 },
  { id: 'fuse', label: 'SIGNAL FUSION', sub: 'RSI · Kelly · imb', x: 360, y: 420, w: 176, h: 72 },
  { id: 'decide', label: 'DECISION', sub: 'early entry · spread', x: 360, y: 520, w: 176, h: 72 },
  { id: 'gate', label: 'ANNOUNCE GATE', sub: 'approve / timeout', x: 640, y: 200, w: 180, h: 72 },
  { id: 'exec', label: 'EXECUTION', sub: 'paper / live fills', x: 640, y: 380, w: 180, h: 72 },
  { id: 'port', label: 'PORTFOLIO', sub: 'cash · PnL · equity', x: 920, y: 290, w: 176, h: 72 },
]

const EDGES = [
  ['spot', 'fuse'], ['gamma', 'fuse'], ['clob', 'decide'],
  ['spot', 'btc-models'], ['spot', 'eth-models'],
  ['btc-models', 'fuse'], ['eth-models', 'fuse'],
  ['fuse', 'decide'], ['decide', 'gate'], ['gate', 'exec'], ['exec', 'port'],
]

const MIN_ZOOM = 0.25
const MAX_ZOOM = 3
const GRID = 24

function nodeById(nodes, id) { return nodes.find(n => n.id === id) }

function centerOf(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 } }

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }

function seeded(n) { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x) }

function roughRect(ctx, x, y, w, h, r = 10, seed = 1) {
  ctx.beginPath()
  let i = seed
  const j = () => { i += 1; return (seeded(i) - 0.5) * 1.4 }
  ctx.moveTo(x + r + j(), y + j())
  ctx.lineTo(x + w - r + j(), y + j())
  ctx.quadraticCurveTo(x + w + j(), y + j(), x + w + j(), y + r + j())
  ctx.lineTo(x + w + j(), y + h - r + j())
  ctx.quadraticCurveTo(x + w + j(), y + h + j(), x + w - r + j(), y + h + j())
  ctx.lineTo(x + r + j(), y + h + j())
  ctx.quadraticCurveTo(x + j(), y + h + j(), x + j(), y + h - r + j())
  ctx.lineTo(x + j(), y + r + j())
  ctx.quadraticCurveTo(x + j(), y + r + j(), x + r + j(), y + j())
  ctx.closePath()
}

function nodeForModel(model) {
  const colorMap = {
    healthy: { bg: 'rgba(34,197,94,0.18)', fg: '#4ade80', border: 'rgba(34,197,94,0.45)' },
    running: { bg: 'rgba(250,204,21,0.15)', fg: '#facc15', border: 'rgba(250,204,21,0.4)' },
    error: { bg: 'rgba(239,68,68,0.18)', fg: '#f87171', border: 'rgba(239,68,68,0.45)' },
    idle: { bg: 'rgba(100,116,139,0.1)', fg: '#64748b', border: 'rgba(100,116,139,0.3)' },
  }
  const c = colorMap[model.status] || colorMap.idle
  const dirArrow = model.direction === 'up' ? '\u2191' : model.direction === 'down' ? '\u2193' : '\u2014'
  const pct = model.confidence != null ? `${(model.confidence * 100).toFixed(0)}%` : ''
  return { color: c, dirArrow, pct }
}

export default function SystemFlow({ running, mode, mlAlive, lastScan, models = [] }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const cam = useRef({ x: 40, y: 20, zoom: 1 })
  const pan = useRef(null)
  const nodeDrag = useRef(null)
  const particles = useRef([])
  const raf = useRef(0)
  const [zoomLabel, setZoomLabel] = useState(100)
  const [tool, setTool] = useState('hand')
  const [expanded, setExpanded] = useState(false)
  const [hoveredNode, setHoveredNode] = useState(null)
  const [nodes, setNodes] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('zf_nodes') || 'null') || DEFAULT_NODES } catch { return DEFAULT_NODES }
  })
  const liveRef = useRef({ running, mlAlive, mode, models, nodes })

  useEffect(() => { liveRef.current = { running, mlAlive, mode, models, nodes } }, [running, mlAlive, mode, models, nodes])

  const fitView = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const pad = 48
    const minX = Math.min(...nodes.map(n => n.x))
    const minY = Math.min(...nodes.map(n => n.y))
    const maxX = Math.max(...nodes.map(n => n.x + n.w))
    const maxY = Math.max(...nodes.map(n => n.y + n.h))
    const bw = maxX - minX; const bh = maxY - minY
    const zw = (el.clientWidth - pad * 2) / bw; const zh = (el.clientHeight - pad * 2) / bh
    const zoom = clamp(Math.min(zw, zh), MIN_ZOOM, MAX_ZOOM)
    cam.current = { zoom, x: pad - minX * zoom + (el.clientWidth - pad * 2 - bw * zoom) / 2, y: pad - minY * zoom + (el.clientHeight - pad * 2 - bh * zoom) / 2 }
    setZoomLabel(Math.round(zoom * 100))
  }, [nodes])

  const zoomAt = useCallback((factor, cx, cy) => {
    const c = cam.current; const prev = c.zoom; const next = clamp(prev * factor, MIN_ZOOM, MAX_ZOOM)
    if (next === prev) return
    const wx = (cx - c.x) / prev; const wy = (cy - c.y) / prev
    c.zoom = next; c.x = cx - wx * next; c.y = cy - wy * next
    setZoomLabel(Math.round(next * 100))
  }, [])

  useEffect(() => { fitView(); const onResize = () => fitView(); window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize) }, [fitView, expanded])

  const worldToScreen = (wx, wy) => {
    const { x, y, zoom } = cam.current
    return { x: wx * zoom + x, y: wy * zoom + y }
  }

  const screenToWorld = (sx, sy) => {
    const { x, y, zoom } = cam.current
    return { x: (sx - x) / zoom, y: (sy - y) / zoom }
  }

  const hitTest = (wx, wy, nodes) => {
    return nodes.find(n => wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h)
  }

  useEffect(() => {
    const canvas = canvasRef.current; const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d'); let alive = true

    particles.current = EDGES.map((_, i) => ({ edge: i, t: Math.random(), speed: 0.003 + Math.random() * 0.004 }))

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2); const w = wrap.clientWidth; const h = wrap.clientHeight
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr)
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize(); const ro = new ResizeObserver(resize); ro.observe(wrap)

    const drawGrid = (w, h) => {
      const { x, y, zoom } = cam.current; const step = GRID * zoom
      if (step < 8) return
      ctx.save(); ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)'; ctx.lineWidth = 1
      const ox = ((x % step) + step) % step; const oy = ((y % step) + step) % step
      ctx.beginPath()
      for (let gx = ox; gx < w; gx += step) { ctx.moveTo(gx, 0); ctx.lineTo(gx, h) }
      for (let gy = oy; gy < h; gy += step) { ctx.moveTo(0, gy); ctx.lineTo(w, gy) }
      ctx.stroke(); ctx.restore()
    }

    const draw = () => {
      if (!alive) return
      const w = wrap.clientWidth; const h = wrap.clientHeight
      const { running: isRun, mode: m, models: ms, nodes: nds } = liveRef.current
      const { zoom } = cam.current; const btcModels = ms.filter(mod => mod.symbol === 'BTC'); const ethModels = ms.filter(mod => mod.symbol === 'ETH')
      const anyHealthy = ms.some(mod => mod.status === 'healthy'); const anyRunning = ms.some(mod => mod.status === 'running')

      ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#0c1018'; ctx.fillRect(0, 0, w, h); drawGrid(w, h)

      EDGES.forEach(([from, to], i) => {
        const a = nodeById(nds, from); const b = nodeById(nds, to)
        if (!a || !b) return
        const ca = centerOf(a); const cb = centerOf(b)
        const sa = worldToScreen(ca.x, ca.y); const sb = worldToScreen(cb.x, cb.y)
        const hot = isRun || i % 3 === Math.floor(performance.now() / 700) % 3
        ctx.save(); ctx.strokeStyle = hot ? 'rgba(163, 230, 53, 0.55)' : 'rgba(100, 116, 139, 0.45)'
        ctx.lineWidth = (hot ? 2.4 : 1.4) * Math.min(zoom, 1.5)
        ctx.setLineDash(hot ? [8 * zoom, 6 * zoom] : [4 * zoom, 6 * zoom])
        ctx.lineDashOffset = hot ? -(performance.now() / 40) : 0; ctx.beginPath()
        const mx = (sa.x + sb.x) / 2; const my = (sa.y + sb.y) / 2 - 18 * zoom
        ctx.moveTo(sa.x, sa.y); ctx.quadraticCurveTo(mx, my, sb.x, sb.y); ctx.stroke(); ctx.restore()
      })

      particles.current.forEach(p => {
        p.t += p.speed * (liveRef.current.running ? 1.6 : 0.7)
        if (p.t > 1) p.t -= 1
        const [from, to] = EDGES[p.edge]; const a = centerOf(nodeById(nds, from)); const b = centerOf(nodeById(nds, to))
        const t = p.t; const wx = a.x + (b.x - a.x) * t; const wy = a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * 24
        const s = worldToScreen(wx, wy)
        ctx.beginPath(); ctx.fillStyle = 'rgba(163, 230, 53, 0.95)'; ctx.arc(s.x, s.y, 3.2 * Math.min(zoom, 1.8), 0, Math.PI * 2); ctx.fill()
      })

      nds.forEach((n, ni) => {
        const seed = ni * 97 + 3
        const isModels = n.id === 'btc-models' || n.id === 'eth-models'
        const lit = (isModels && anyHealthy) || (n.id === 'exec' && isRun) || n.id === 'port' || (n.id === 'decide' && isRun) || (n.id === 'fuse' && anyHealthy)
        const tl = worldToScreen(n.x, n.y); const nw = n.w * zoom; const nh = n.h * zoom

        ctx.save()
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; roughRect(ctx, tl.x + 3, tl.y + 4, nw, nh, 12 * zoom, seed + 17); ctx.fill()
        ctx.fillStyle = lit ? 'rgba(36, 52, 28, 0.95)' : 'rgba(22, 28, 40, 0.96)'; roughRect(ctx, tl.x, tl.y, nw, nh, 12 * zoom, seed); ctx.fill()
        ctx.strokeStyle = hoveredNode === n.id ? 'rgba(163, 230, 53, 1)' : (lit ? 'rgba(163, 230, 53, 0.85)' : 'rgba(71, 85, 105, 0.9)')
        ctx.lineWidth = (hoveredNode === n.id ? 3 : (lit ? 2.2 : 1.4)) * Math.min(zoom, 1.6)
        roughRect(ctx, tl.x, tl.y, nw, nh, 12 * zoom, seed); ctx.stroke()

        ctx.fillStyle = lit ? '#bef264' : '#e2e8f0'; ctx.font = `700 ${Math.max(11, 13 * zoom)}px "IBM Plex Mono", monospace`
        ctx.textAlign = 'center'; ctx.fillText(n.label, tl.x + nw / 2, tl.y + nh * 0.26)
        ctx.fillStyle = '#94a3b8'; ctx.font = `500 ${Math.max(9, 11 * zoom)}px "IBM Plex Mono", monospace`
        ctx.fillText(n.sub, tl.x + nw / 2, tl.y + nh * 0.4)

        if (isModels) {
          const asset = n.id === 'btc-models' ? 'BTC' : 'ETH'; const assetModels = asset === 'BTC' ? btcModels : ethModels
          if (assetModels.length === 0) {
            ctx.fillStyle = '#64748b'; ctx.font = `500 ${Math.max(8, 10 * zoom)}px "IBM Plex Mono", monospace`
            ctx.fillText('no data', tl.x + nw / 2, tl.y + nh * 0.65)
          } else {
            const pillW = 60 * zoom; const pillH = 20 * zoom; const cols = 3; const gapX = 8 * zoom; const gapY = 6 * zoom
            const totalRowW = cols * pillW + (cols - 1) * gapX
            const startX = tl.x + (nw - totalRowW) / 2; const startY = tl.y + nh * 0.48
            assetModels.slice(0, 6).forEach((mod, idx) => {
              const col = idx % cols; const row = Math.floor(idx / cols)
              const px = startX + col * (pillW + gapX); const py = startY + row * (pillH + gapY)
              const { color, dirArrow, pct } = nodeForModel(mod)
              ctx.fillStyle = color.bg; ctx.strokeStyle = color.border; ctx.lineWidth = 1
              const r = 4 * zoom; ctx.beginPath(); ctx.roundRect(px, py, pillW, pillH, r); ctx.fill(); ctx.stroke()
              ctx.fillStyle = color.fg; ctx.font = `600 ${Math.max(8, 10 * zoom)}px "IBM Plex Mono", monospace`
              ctx.textAlign = 'left'; ctx.fillText(mod.label, px + 4 * zoom, py + pillH / 2 + 3 * zoom)
              ctx.textAlign = 'right'; ctx.fillText(`${dirArrow}${pct}`, px + pillW - 4 * zoom, py + pillH / 2 + 3 * zoom)
            })
          }
        }

        ctx.restore()
      })

      if (hoveredNode && liveRef.current.mode) {
        const n = nodeById(nds, hoveredNode); if (!n) return
        const tl = worldToScreen(n.x, n.y); const nw = n.w * zoom; const nh = n.h * zoom
        const tooltipX = tl.x + nw / 2; const tooltipY = tl.y - 8 * zoom
        ctx.save(); ctx.font = `500 ${10 * zoom}px "IBM Plex Mono", monospace`
        const asset = n.id === 'btc-models' ? 'BTC' : n.id === 'eth-models' ? 'ETH' : null
        const infoLines = [`${n.label}`]
        if (asset) {
          const assetModels = asset === 'BTC' ? btcModels : ethModels
          infoLines.push(`${assetModels.length} models · ${assetModels.filter(m => m.status === 'healthy').length} healthy`)
          const dirs = assetModels.filter(m => m.direction).map(m => m.direction)
          if (dirs.length) infoLines.push(`↑${dirs.filter(d => d === 'up').length} ↓${dirs.filter(d => d === 'down').length}`)
        }
        const maxLineWidth = Math.max(...infoLines.map(l => ctx.measureText(l).width))
        const boxPad = 6 * zoom; const boxW = maxLineWidth + boxPad * 2; const boxH = infoLines.length * 14 * zoom + boxPad * 2
        ctx.fillStyle = 'rgba(12, 16, 24, 0.92)'; ctx.strokeStyle = 'rgba(163, 230, 53, 0.5)'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.roundRect(tooltipX - boxW / 2, tooltipY - boxH - 4 * zoom, boxW, boxH, 4 * zoom); ctx.fill(); ctx.stroke()
        ctx.fillStyle = '#a3e635'; ctx.textAlign = 'center'
        infoLines.forEach((line, i) => ctx.fillText(line, tooltipX, tooltipY - boxH + boxPad + i * 14 * zoom + 10 * zoom))
        ctx.restore()
      }

      ctx.save()
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)'; ctx.fillRect(12, 12, 260, 36)
      ctx.strokeStyle = 'rgba(163, 230, 53, 0.25)'; ctx.strokeRect(12, 12, 260, 36)
      ctx.fillStyle = '#a3e635'; ctx.font = '600 11px "IBM Plex Mono", monospace'; ctx.textAlign = 'left'
      ctx.fillText([String(m || 'paper').toUpperCase(), isRun ? 'ENGAGED' : 'HOLD', anyRunning ? 'RUNNING' : anyHealthy ? 'HOT' : 'IDLE', `${ms.filter(x => x.status === 'healthy').length}/${ms.length}`].join(' · '), 22, 34)
      ctx.restore()

      raf.current = requestAnimationFrame(draw)
    }

    raf.current = requestAnimationFrame(draw)
    return () => { alive = false; cancelAnimationFrame(raf.current); ro.disconnect() }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const onDown = (e) => {
      const rect = canvas.getBoundingClientRect()
      const sx = e.clientX - rect.left; const sy = e.clientY - rect.top
      const w = worldToScreen; const sw = screenToWorld(sx, sy)
      const { nodes: nds } = liveRef.current

      if (tool === 'node') {
        const hit = hitTest(sw.x, sw.y, nds)
        if (hit) {
          nodeDrag.current = { id: hit.id, ox: hit.x, oy: hit.y, px: e.clientX, py: e.clientY }
          canvas.setPointerCapture(e.pointerId); return
        }
      }

      if (tool === 'hand' || e.button === 1) {
        pan.current = { px: e.clientX, py: e.clientY, cx: cam.current.x, cy: cam.current.y }
        canvas.setPointerCapture(e.pointerId)
      }
    }
    const onMove = (e) => {
      if (nodeDrag.current) {
        const dx = (e.clientX - nodeDrag.current.px) / cam.current.zoom
        const dy = (e.clientY - nodeDrag.current.py) / cam.current.zoom
        setNodes(prev => prev.map(n => n.id === nodeDrag.current.id ? { ...n, x: nodeDrag.current.ox + dx, y: nodeDrag.current.oy + dy } : n))
        return
      }
      if (pan.current) { cam.current.x = pan.current.cx + (e.clientX - pan.current.px); cam.current.y = pan.current.cy + (e.clientY - pan.current.py) }

      if (tool === 'node') {
        const sw = screenToWorld(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top)
        const hit = hitTest(sw.x, sw.y, liveRef.current.nodes)
        setHoveredNode(hit ? hit.id : null)
      }
    }
    const onUp = (e) => {
      if (nodeDrag.current) {
        sessionStorage.setItem('zf_nodes', JSON.stringify(liveRef.current.nodes))
        nodeDrag.current = null
      }
      pan.current = null
      try { canvas.releasePointerCapture(e.pointerId) } catch {}
    }
    const onWheel = (e) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      zoomAt(e.deltaY < 0 ? 1.08 : 1 / 1.08, e.clientX - rect.left, e.clientY - rect.top)
    }

    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('wheel', onWheel) }
  }, [tool, zoomAt])

  const bumpZoom = (dir) => {
    const wrap = wrapRef.current; if (!wrap) return
    zoomAt(dir > 0 ? 1.15 : 1 / 1.15, wrap.clientWidth / 2, wrap.clientHeight / 2)
  }

  return (
    <div className={cn('flow-shell relative overflow-hidden rounded-lg border border-primary/25 bg-[#0c1018]', expanded ? 'fixed inset-3 z-50 shadow-2xl' : '')}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2 sm:px-4">
        <div>
          <div className="font-mono text-[0.55rem] tracking-[0.22em] text-primary uppercase">Mission dataflow</div>
          <div className="text-muted-foreground text-xs">
            {tool === 'node' ? '✋ Drag nodes to rearrange · hover for model info' : 'Drag to pan · scroll to zoom'} ·
            {lastScan ? ` scan ${new Date(lastScan).toLocaleTimeString()}` : ' awaiting scan'}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" variant={tool === 'hand' ? 'default' : 'outline'} className="h-8 px-2" onClick={() => setTool('hand')} title="Pan mode"><Hand className="size-3.5" /></Button>
          <Button type="button" size="sm" variant={tool === 'node' ? 'default' : 'outline'} className="h-8 px-2" onClick={() => setTool('node')} title="Move nodes"><GripVertical className="size-3.5" /></Button>
          <Button type="button" size="sm" variant="outline" className="h-8 px-2" onClick={() => bumpZoom(-1)} title="Zoom out"><Minus className="size-3.5" /></Button>
          <span className="text-muted-foreground min-w-[3rem] text-center font-mono text-[0.65rem]">{zoomLabel}%</span>
          <Button type="button" size="sm" variant="outline" className="h-8 px-2" onClick={() => bumpZoom(1)} title="Zoom in"><Plus className="size-3.5" /></Button>
          <Button type="button" size="sm" variant="outline" className="h-8 px-2" onClick={fitView} title="Fit view"><Crosshair className="size-3.5" /></Button>
          <Button type="button" size="sm" variant="outline" className="h-8 px-2" onClick={() => { try { sessionStorage.removeItem('zf_nodes'); setNodes(DEFAULT_NODES) } catch {} }} title="Reset layout"><Info className="size-3.5" /></Button>
          <Button type="button" size="sm" variant="outline" className="h-8 px-2" onClick={() => setExpanded(v => !v)} title={expanded ? 'Exit' : 'Fullscreen'}><Maximize2 className="size-3.5" /></Button>
        </div>
      </div>
      <div ref={wrapRef} className={cn('relative w-full touch-none', expanded ? 'h-[calc(100%-3rem)]' : 'h-[400px] sm:h-[480px]', tool === 'hand' ? 'cursor-grab active:cursor-grabbing' : tool === 'node' ? 'cursor-default' : 'cursor-default')}>
        <canvas ref={canvasRef} className="block h-full w-full" aria-label="Mission dataflow canvas" />
      </div>
    </div>
  )
}