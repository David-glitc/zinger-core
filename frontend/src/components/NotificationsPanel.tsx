// @ts-nocheck
import { useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { LiveTimeAgo, fmtTimeMs } from '../polyTimers'

const TYPE_TONE = {
  buy: 'border-primary/40 bg-primary/5',
  arb: 'border-primary/50 bg-primary/10',
  tp: 'border-primary/40',
  sl: 'border-destructive/40',
  error: 'border-destructive/50',
  announce: 'border-amber-500/40',
  signal: 'border-border',
  system: 'border-border/60',
}

export default function NotificationsPanel({
  actions = [],
  pending = [],
  notifications = [],
  unread = 0,
  open,
  onOpenChange,
  onMarkRead,
}) {
  const items = (notifications?.length ? notifications : actions || []).slice(0, 50)
  const count = (pending?.length || 0) + (unread || 0) || Math.min(items.filter((i) => !i.read).length, 9)
  const [filter, setFilter] = useState('all')
  const filtered = filter === 'all'
    ? items
    : items.filter((a) => (a.type || '').toLowerCase() === filter)

  useEffect(() => {
    if (open && onMarkRead) onMarkRead()
  }, [open, onMarkRead])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="relative h-10 gap-2 px-3 sm:h-9"
          aria-label="Notifications"
        >
          <Bell className={cn('size-4', count > 0 && 'text-primary')} />
          <span className="hidden sm:inline">Alerts</span>
          {count > 0 && (
            <Badge
              variant="secondary"
              className="absolute -top-1.5 -right-1.5 h-5 min-w-5 justify-center rounded-full px-1 text-[0.65rem]"
            >
              {count > 9 ? '9+' : count}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b border-border/60 px-1 pb-4 text-left">
          <SheetTitle>Bot alerts</SheetTitle>
          <SheetDescription>
            Agile fills · SL/TP · arb · announces · {items.length} recent
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-wrap gap-1 border-b border-border/50 px-3 py-2">
          {['all', 'buy', 'arb', 'sl', 'tp', 'announce', 'error'].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded border px-2 py-0.5 font-mono text-[0.6rem] uppercase',
                filter === f ? 'border-primary/50 text-primary' : 'border-border/60 text-muted-foreground',
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {pending?.length > 0 && (
          <div className="border-b border-border/50 bg-primary/5 px-4 py-3">
            <div className="mb-2 font-mono text-[0.65rem] tracking-wider text-primary uppercase">
              Pending approval
            </div>
            <div className="flex flex-col gap-2">
              {pending.slice(0, 5).map((p) => (
                <div
                  key={p.id}
                  className="rounded-lg border border-primary/30 bg-card px-3 py-2.5 text-sm"
                >
                  <div className="font-medium">
                    {p.symbol} {String(p.outcome || '').toUpperCase()}
                  </div>
                  <div className="text-muted-foreground font-mono text-xs">
                    {p.msg || p.plan?.msg || 'Awaiting approve'}
                    {p.plan?.slPct != null && ` · SL -${p.plan.slPct}% · TP +${p.plan.targetTp}%`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <ScrollArea className="flex-1 px-1">
          <div className="flex flex-col gap-2 py-4 pr-3">
            {filtered.length === 0 ? (
              <div className="text-muted-foreground px-3 py-10 text-center text-sm">
                No alerts yet — start the bot to stream actions.
              </div>
            ) : (
              filtered.map((a, i) => (
                <div
                  key={a.id || `${a.time}-${i}`}
                  className={cn(
                    'rounded-lg border bg-card/80 px-3.5 py-3',
                    TYPE_TONE[a.type] || 'border-border/60',
                    !a.read && 'ring-1 ring-primary/20',
                  )}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <Badge variant="outline" className="font-mono text-[0.6rem] uppercase">
                      {a.type || a.title || 'info'}
                    </Badge>
                    <span className="text-muted-foreground font-mono text-[0.65rem]">
                      {a.time ? fmtTimeMs(a.time) : <LiveTimeAgo ts={a.timestamp} />}
                    </span>
                  </div>
                  <p className="text-sm leading-snug">{a.msg || a.message || a.title || JSON.stringify(a.meta || {})}</p>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
