import '@rainbow-me/rainbowkit/styles.css'
import { getDefaultConfig, RainbowKitProvider, ConnectButton } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { polygon } from 'wagmi/chains'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http } from 'wagmi'
import { useCallback, useEffect, useState } from 'react'

/** Operator wallet (optional connect for CLOB / display) */
export const AUTHORIZED_ADDRESS = '0x5bc2e3dd60c625dda51bac0cf5c3023d45f5e600'.toLowerCase()

const WC_PROJECT_ID =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_WC_PROJECT_ID) ||
  '01501bedd93bd3f64bf63064f3c7f79a'

const wagmiConfig = getDefaultConfig({
  appName: 'Zinger',
  projectId: WC_PROJECT_ID,
  chains: [polygon],
  transports: { [polygon.id]: http('https://polygon-bor.publicnode.com') },
  ssr: false,
})

const queryClient = new QueryClient()

function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'
}

export function WalletProviders({ children }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider modalSize="compact" initialChain={polygon}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

async function fetchAuthStatus() {
  const r = await fetch('/api/auth/status', { credentials: 'same-origin' })
  if (!r.ok) return { authenticated: false, configured: false }
  return r.json()
}

/**
 * Password gate — works from any device. Session cookie lasts 30 days.
 * Wallet connect remains optional inside the terminal.
 */
export function AuthGate({ children }) {
  const [booted, setBooted] = useState(false)
  const [authed, setAuthed] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await fetchAuthStatus()
      setConfigured(s.configured !== false)
      setAuthed(Boolean(s.authenticated))
    } catch {
      setAuthed(false)
    } finally {
      setBooted(true)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function onSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setError(data.error === 'invalid password' ? 'Wrong password' : (data.error || 'Login failed'))
        setAuthed(false)
        return
      }
      setPassword('')
      setAuthed(true)
    } catch {
      setError('Network error')
    } finally {
      setBusy(false)
    }
  }

  if (!booted) {
    return (
      <div className="dark flex min-h-svh items-center justify-center bg-background">
        <div className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          Checking session…
        </div>
      </div>
    )
  }

  if (!authed) {
    return (
      <div className="dark poly-shell flex min-h-svh items-center justify-center p-4 sm:p-6">
        <form
          onSubmit={onSubmit}
          className="border-border/70 bg-card/90 w-full max-w-sm rounded-xl border p-5 text-center shadow-sm sm:p-6"
        >
          <img src="/favicon.svg" alt="" className="mx-auto mb-3 size-10 sm:mb-4 sm:size-12" />
          <div className="text-foreground mb-1 text-lg font-bold tracking-[0.16em] sm:text-xl">ZINGER</div>
          <div className="text-muted-foreground mb-5 text-sm">
            {configured ? 'Enter operator password to continue.' : 'AUTH_PASSWORD is not set on the server.'}
          </div>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            disabled={!configured || busy}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="border-border bg-background text-foreground mb-3 w-full rounded-md border px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          {error && <div className="text-destructive mb-3 text-xs">{error}</div>}
          <button
            type="submit"
            disabled={!configured || busy || !password}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 w-full rounded-md px-3 py-2.5 text-sm font-semibold tracking-wide"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <div className="text-muted-foreground mt-5 font-mono text-[0.65rem]">
            Session cookie · any device · 30 days
          </div>
        </form>
      </div>
    )
  }

  return children
}

/** @deprecated use AuthGate — kept as alias for older imports */
export const WalletGate = AuthGate

export async function logoutAuth() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
  window.location.reload()
}

export { ConnectButton, shortAddr }
