'use client'

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { callAIAgent, extractText } from '@/lib/aiAgent'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Progress } from '@/components/ui/progress'
import {
  HiOutlinePlay,
  HiOutlineChartBar,
  HiOutlineClock,
  HiOutlineWallet,
  HiArrowUp,
  HiArrowDown,
  HiCheck,
  HiXMark,
  HiArrowPath,
  HiPaperAirplane,
  HiShieldCheck,
  HiLightBulb,
  HiSignal,
  HiMinus,
  HiPlus,
  HiBolt,
  HiTrophy,
  HiExclamationTriangle,
  HiInformationCircle,
  HiLink,
  HiArrowRightOnRectangle,
  HiGlobeAlt,
} from 'react-icons/hi2'
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from 'recharts'

// ============================================================
// AGENT IDS
// ============================================================
const WALLET_AGENT_ID = '699bfdccfb62c45cbd3beb71'
const FAIRNESS_AGENT_ID = '699bfdcc445882528cc4bd5a'
const MATCH_INSIGHT_AGENT_ID = '699bfdcc4781b21fa6458747'

// ============================================================
// SOLANA DEVNET CONFIG
// ============================================================
const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com'
const LAMPORTS_PER_SOL = 1_000_000_000

// ============================================================
// TYPES
// ============================================================
type TabId = 'play' | 'dashboard' | 'history' | 'wallet'
type MatchOutcome = 'Win' | 'Loss' | 'Forfeit'
type MatchState = 'idle' | 'waiting' | 'matched' | 'choosing' | 'flipping' | 'result'
type CoinSide = 'Heads' | 'Tails'
type TxnType = 'Deposit' | 'Withdrawal' | 'Wager Lock' | 'Payout' | 'Fee' | 'Airdrop'
type TxnStatus = 'Confirmed' | 'Pending' | 'Failed'

interface MatchRecord {
  id: string
  opponent: string
  wager: number
  outcome: MatchOutcome
  timestamp: string
  tier: number
  playerChoice: CoinSide
  result: CoinSide
  commitHash: string
  nonce: string
  streak: number
  txSignature?: string
}

interface Transaction {
  id: string
  type: TxnType
  amount: number
  status: TxnStatus
  timestamp: string
  description: string
  signature?: string
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

// ============================================================
// PHANTOM WALLET TYPES
// ============================================================
interface PhantomProvider {
  isPhantom?: boolean
  publicKey: { toString: () => string; toBytes: () => Uint8Array } | null
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString: () => string } }>
  disconnect: () => Promise<void>
  signTransaction: (tx: any) => Promise<any>
  signAllTransactions: (txs: any[]) => Promise<any[]>
  signMessage: (msg: Uint8Array) => Promise<{ signature: Uint8Array }>
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
}

declare global {
  interface Window {
    solana?: PhantomProvider
    phantom?: { solana?: PhantomProvider }
  }
}

// ============================================================
// HELPERS
// ============================================================
function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 10) return addr || ''
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function renderMarkdown(text: string) {
  if (!text) return null
  return (
    <div className="space-y-2">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('### ')) return <h4 key={i} className="font-semibold text-sm mt-3 mb-1">{line.slice(4)}</h4>
        if (line.startsWith('## ')) return <h3 key={i} className="font-semibold text-base mt-3 mb-1">{line.slice(3)}</h3>
        if (line.startsWith('# ')) return <h2 key={i} className="font-bold text-lg mt-4 mb-2">{line.slice(2)}</h2>
        if (line.startsWith('- ') || line.startsWith('* ')) return <li key={i} className="ml-4 list-disc text-sm">{formatInline(line.slice(2))}</li>
        if (/^\d+\.\s/.test(line)) return <li key={i} className="ml-4 list-decimal text-sm">{formatInline(line.replace(/^\d+\.\s/, ''))}</li>
        if (!line.trim()) return <div key={i} className="h-1" />
        return <p key={i} className="text-sm">{formatInline(line)}</p>
      })}
    </div>
  )
}

function formatInline(text: string) {
  const parts = text.split(/\*\*(.*?)\*\*/g)
  if (parts.length === 1) return text
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-semibold">{part}</strong> : part
  )
}

// Generate a simulated commit hash using crypto
function generateCommitHash(choice: string, nonce: string): string {
  const data = `${choice}:${nonce}`
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return '0x' + Math.abs(hash).toString(16).padStart(16, '0') + Math.random().toString(16).slice(2, 18)
}

// ============================================================
// SOLANA RPC HELPERS (direct fetch, no SDK dependency issues)
// ============================================================
async function getBalance(publicKeyStr: string): Promise<number> {
  const response = await fetch(SOLANA_DEVNET_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [publicKeyStr],
    }),
  })
  const data = await response.json()
  if (data.result?.value !== undefined) {
    return data.result.value / LAMPORTS_PER_SOL
  }
  throw new Error(data.error?.message || 'Failed to fetch balance')
}

async function requestAirdrop(publicKeyStr: string, solAmount: number): Promise<string> {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL)
  const response = await fetch(SOLANA_DEVNET_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'requestAirdrop',
      params: [publicKeyStr, lamports],
    }),
  })
  const data = await response.json()
  if (data.result) {
    return data.result
  }
  throw new Error(data.error?.message || 'Airdrop failed')
}

async function confirmTransaction(signature: string, maxRetries = 30): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const response = await fetch(SOLANA_DEVNET_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }],
      }),
    })
    const data = await response.json()
    const status = data.result?.value?.[0]
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return !status.err
    }
  }
  return false
}

async function getRecentTransactions(publicKeyStr: string, limit = 10): Promise<any[]> {
  const response = await fetch(SOLANA_DEVNET_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [publicKeyStr, { limit }],
    }),
  })
  const data = await response.json()
  return Array.isArray(data.result) ? data.result : []
}

// ============================================================
// NEON STYLE CONSTANTS
// ============================================================
const NEON_CYAN_GLOW = '0 0 10px hsl(180 100% 50% / 0.3), 0 0 20px hsl(180 100% 50% / 0.15)'
const NEON_MAGENTA_GLOW = '0 0 10px hsl(300 80% 50% / 0.3), 0 0 20px hsl(300 80% 50% / 0.15)'
const NEON_GREEN_GLOW = '0 0 10px hsl(120 100% 50% / 0.3)'
const NEON_RED_GLOW = '0 0 10px hsl(0 100% 55% / 0.3)'
const GLASS_BG = 'rgba(23, 17, 42, 0.85)'
const GLASS_BORDER = 'rgba(255,255,255,0.1)'

// ============================================================
// ERROR BOUNDARY
// ============================================================
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: '' }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
          <div className="text-center p-8 max-w-md">
            <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
            <p className="text-muted-foreground mb-4 text-sm">{this.state.error}</p>
            <button onClick={() => this.setState({ hasError: false, error: '' })} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">Try again</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ============================================================
// SUB COMPONENTS
// ============================================================
function NeonSpinner({ size = 40 }: { size?: number }) {
  return (
    <div className="flex items-center justify-center">
      <div
        className="rounded-full animate-spin"
        style={{
          width: size,
          height: size,
          border: '3px solid hsl(260 20% 15%)',
          borderTopColor: 'hsl(180 100% 50%)',
          boxShadow: NEON_CYAN_GLOW,
        }}
      />
    </div>
  )
}

function GlassCard({ children, className, glowColor, style }: { children: React.ReactNode; className?: string; glowColor?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={cn('rounded backdrop-blur-[12px] p-4', className)}
      style={{
        background: GLASS_BG,
        border: `1px solid ${GLASS_BORDER}`,
        boxShadow: glowColor || 'none',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function OutcomeBadge({ outcome }: { outcome: MatchOutcome }) {
  if (outcome === 'Win') {
    return (
      <Badge className="text-xs font-semibold tracking-wide" style={{ background: 'hsl(120 100% 50% / 0.15)', color: 'hsl(120 100% 60%)', border: '1px solid hsl(120 100% 50% / 0.3)' }}>
        WIN
      </Badge>
    )
  }
  if (outcome === 'Loss') {
    return (
      <Badge className="text-xs font-semibold tracking-wide" style={{ background: 'hsl(0 100% 55% / 0.15)', color: 'hsl(0 100% 65%)', border: '1px solid hsl(0 100% 55% / 0.3)' }}>
        LOSS
      </Badge>
    )
  }
  return (
    <Badge className="text-xs font-semibold tracking-wide" style={{ background: 'hsl(60 100% 50% / 0.15)', color: 'hsl(60 100% 60%)', border: '1px solid hsl(60 100% 50% / 0.3)' }}>
      FORFEIT
    </Badge>
  )
}

function TxnStatusBadge({ status }: { status: TxnStatus }) {
  if (status === 'Confirmed') {
    return (
      <Badge className="text-xs" style={{ background: 'hsl(120 100% 50% / 0.15)', color: 'hsl(120 100% 60%)', border: '1px solid hsl(120 100% 50% / 0.3)' }}>
        <HiCheck className="w-3 h-3 mr-1" /> Confirmed
      </Badge>
    )
  }
  if (status === 'Failed') {
    return (
      <Badge className="text-xs" style={{ background: 'hsl(0 100% 55% / 0.15)', color: 'hsl(0 100% 65%)', border: '1px solid hsl(0 100% 55% / 0.3)' }}>
        <HiXMark className="w-3 h-3 mr-1" /> Failed
      </Badge>
    )
  }
  return (
    <Badge className="text-xs" style={{ background: 'hsl(60 100% 50% / 0.15)', color: 'hsl(60 100% 60%)', border: '1px solid hsl(60 100% 50% / 0.3)' }}>
      <HiArrowPath className="w-3 h-3 mr-1 animate-spin" /> Pending
    </Badge>
  )
}

function CoinFlipVisual({ isFlipping, result }: { isFlipping: boolean; result: CoinSide | null }) {
  return (
    <div className="flex flex-col items-center justify-center py-6">
      <div
        className="w-24 h-24 rounded-full flex items-center justify-center text-2xl font-bold tracking-wider"
        style={{
          background: isFlipping
            ? 'linear-gradient(135deg, hsl(180 100% 50%), hsl(300 80% 50%))'
            : result === 'Heads'
            ? 'linear-gradient(135deg, hsl(180 100% 50%), hsl(180 100% 30%))'
            : 'linear-gradient(135deg, hsl(300 80% 50%), hsl(300 80% 30%))',
          boxShadow: isFlipping
            ? `${NEON_CYAN_GLOW}, ${NEON_MAGENTA_GLOW}`
            : result === 'Heads'
            ? NEON_CYAN_GLOW
            : NEON_MAGENTA_GLOW,
          color: 'hsl(260 30% 6%)',
          animation: isFlipping ? 'coinSpin 0.6s linear infinite' : 'none',
          transformStyle: 'preserve-3d',
        }}
      >
        {isFlipping ? '' : result === 'Heads' ? 'H' : result === 'Tails' ? 'T' : '?'}
      </div>
      {isFlipping && (
        <p className="mt-4 text-sm text-muted-foreground animate-pulse tracking-wide">Flipping...</p>
      )}
      {!isFlipping && result && (
        <p className="mt-4 text-lg font-bold tracking-wider" style={{ color: result === 'Heads' ? 'hsl(180 100% 50%)' : 'hsl(300 80% 50%)' }}>
          {result}
        </p>
      )}
    </div>
  )
}

function AgentStatusPanel({ activeAgentId }: { activeAgentId: string | null }) {
  const agents = [
    { id: WALLET_AGENT_ID, name: 'Wallet Assistant', purpose: 'Answers wallet & balance questions' },
    { id: FAIRNESS_AGENT_ID, name: 'Fairness Verifier', purpose: 'Verifies match fairness' },
    { id: MATCH_INSIGHT_AGENT_ID, name: 'Match Insight', purpose: 'Provides match analysis' },
  ]
  return (
    <GlassCard className="mt-4">
      <div className="flex items-center gap-2 mb-3">
        <HiBolt className="w-4 h-4" style={{ color: 'hsl(180 100% 50%)' }} />
        <span className="text-xs font-semibold tracking-wider uppercase" style={{ color: 'hsl(180 100% 50%)' }}>AI Agents</span>
      </div>
      <div className="space-y-2">
        {agents.map((agent) => (
          <div key={agent.id} className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{
                background: activeAgentId === agent.id ? 'hsl(120 100% 50%)' : 'hsl(260 20% 25%)',
                boxShadow: activeAgentId === agent.id ? NEON_GREEN_GLOW : 'none',
              }}
            />
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium block truncate">{agent.name}</span>
              <span className="text-xs text-muted-foreground block truncate">{agent.purpose}</span>
            </div>
            {activeAgentId === agent.id && (
              <NeonSpinner size={14} />
            )}
          </div>
        ))}
      </div>
    </GlassCard>
  )
}

// ============================================================
// MAIN PAGE
// ============================================================
export default function Page() {
  // Tab navigation
  const [activeTab, setActiveTab] = useState<TabId>('play')

  // ==========================================
  // PHANTOM WALLET STATE (REAL SOLANA DEVNET)
  // ==========================================
  const [phantomProvider, setPhantomProvider] = useState<PhantomProvider | null>(null)
  const [walletConnected, setWalletConnected] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [walletBalance, setWalletBalance] = useState(0)
  const [escrowBalance, setEscrowBalance] = useState(0)
  const [isPhantomInstalled, setIsPhantomInstalled] = useState(false)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [networkStatus, setNetworkStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking')

  // Airdrop state
  const [airdropLoading, setAirdropLoading] = useState(false)
  const [airdropMessage, setAirdropMessage] = useState('')

  // Play state
  const [selectedTier, setSelectedTier] = useState<number | null>(null)
  const [customTier, setCustomTier] = useState('')
  const [matchState, setMatchState] = useState<MatchState>('idle')
  const [opponent, setOpponent] = useState('')
  const [playerChoice, setPlayerChoice] = useState<CoinSide | null>(null)
  const [flipResult, setFlipResult] = useState<CoinSide | null>(null)
  const [matchOutcome, setMatchOutcome] = useState<MatchOutcome | null>(null)
  const [revealTimer, setRevealTimer] = useState(30)
  const revealIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Deposit/Withdraw modal
  const [showDeposit, setShowDeposit] = useState(false)
  const [depositAmount, setDepositAmount] = useState('')
  const [showWithdraw, setShowWithdraw] = useState(false)
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [depositLoading, setDepositLoading] = useState(false)
  const [withdrawLoading, setWithdrawLoading] = useState(false)

  // Match history
  const [matchHistory, setMatchHistory] = useState<MatchRecord[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])

  // Dashboard chart
  const [chartData, setChartData] = useState<{ match: string; earnings: number }[]>([])

  // Filters for history
  const [historyTierFilter, setHistoryTierFilter] = useState<number | null>(null)
  const [historyOutcomeFilter, setHistoryOutcomeFilter] = useState<MatchOutcome | 'All'>('All')

  // Insight state
  const [insightMap, setInsightMap] = useState<Record<string, { summary: string; quip: string; loading: boolean }>>({})

  // Fairness state
  const [fairnessResult, setFairnessResult] = useState<{ explanation: string; verdict: string } | null>(null)
  const [fairnessLoading, setFairnessLoading] = useState(false)
  const [fairnessError, setFairnessError] = useState('')

  // Wallet chat
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)

  // Active agent
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)

  // Error messages
  const [playError, setPlayError] = useState('')
  const [insightError, setInsightError] = useState('')
  const [chatError, setChatError] = useState('')

  // --------------------------------------------------------
  // DETECT PHANTOM WALLET
  // --------------------------------------------------------
  useEffect(() => {
    const checkPhantom = () => {
      const provider = window?.phantom?.solana || window?.solana
      if (provider?.isPhantom) {
        setPhantomProvider(provider)
        setIsPhantomInstalled(true)

        // Check if already connected
        if (provider.publicKey) {
          setWalletConnected(true)
          setWalletAddress(provider.publicKey.toString())
        }

        // Listen for account changes
        provider.on('accountChanged', (publicKey: any) => {
          if (publicKey) {
            setWalletAddress(publicKey.toString())
          } else {
            setWalletConnected(false)
            setWalletAddress('')
            setWalletBalance(0)
          }
        })

        provider.on('disconnect', () => {
          setWalletConnected(false)
          setWalletAddress('')
          setWalletBalance(0)
        })
      }
    }

    // Phantom injects after DOM load
    if (typeof window !== 'undefined') {
      if (window?.phantom?.solana || window?.solana) {
        checkPhantom()
      } else {
        // Wait for injection
        const timer = setTimeout(checkPhantom, 500)
        return () => clearTimeout(timer)
      }
    }
  }, [])

  // --------------------------------------------------------
  // CHECK DEVNET CONNECTION
  // --------------------------------------------------------
  useEffect(() => {
    const checkNetwork = async () => {
      try {
        setNetworkStatus('checking')
        const response = await fetch(SOLANA_DEVNET_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        })
        const data = await response.json()
        setNetworkStatus(data.result === 'ok' ? 'connected' : 'disconnected')
      } catch {
        setNetworkStatus('disconnected')
      }
    }
    checkNetwork()
    const interval = setInterval(checkNetwork, 30000)
    return () => clearInterval(interval)
  }, [])

  // --------------------------------------------------------
  // FETCH BALANCE WHEN WALLET CONNECTED
  // --------------------------------------------------------
  const fetchBalance = useCallback(async () => {
    if (!walletAddress) return
    setBalanceLoading(true)
    try {
      const bal = await getBalance(walletAddress)
      setWalletBalance(bal)
    } catch (err) {
      console.error('Balance fetch error:', err)
    } finally {
      setBalanceLoading(false)
    }
  }, [walletAddress])

  useEffect(() => {
    if (walletConnected && walletAddress) {
      fetchBalance()
      const interval = setInterval(fetchBalance, 15000)
      return () => clearInterval(interval)
    }
  }, [walletConnected, walletAddress, fetchBalance])

  // Update chart data when match history changes
  useEffect(() => {
    if (matchHistory.length > 0) {
      let cumulative = 0
      const data = matchHistory.slice().reverse().map((m, i) => {
        if (m.outcome === 'Win') cumulative += m.wager * 0.975
        else if (m.outcome === 'Loss') cumulative -= m.wager
        return { match: `${i + 1}`, earnings: parseFloat(cumulative.toFixed(3)) }
      })
      setChartData(data)
    }
  }, [matchHistory])

  // Scroll chat
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [chatMessages])

  // --------------------------------------------------------
  // CONNECT PHANTOM WALLET
  // --------------------------------------------------------
  const connectWallet = useCallback(async () => {
    setConnectionError('')
    if (!isPhantomInstalled || !phantomProvider) {
      setConnectionError('Phantom wallet not found. Please install it from phantom.app')
      return
    }
    try {
      const response = await phantomProvider.connect()
      setWalletConnected(true)
      setWalletAddress(response.publicKey.toString())
    } catch (err: any) {
      setConnectionError(err?.message || 'Failed to connect wallet')
    }
  }, [isPhantomInstalled, phantomProvider])

  const disconnectWallet = useCallback(async () => {
    if (phantomProvider) {
      try {
        await phantomProvider.disconnect()
      } catch {}
    }
    setWalletConnected(false)
    setWalletAddress('')
    setWalletBalance(0)
    setEscrowBalance(0)
  }, [phantomProvider])

  // --------------------------------------------------------
  // AIRDROP (DEVNET FAUCET)
  // --------------------------------------------------------
  const handleAirdrop = useCallback(async (amount: number = 1) => {
    if (!walletAddress) return
    setAirdropLoading(true)
    setAirdropMessage('')
    try {
      const sig = await requestAirdrop(walletAddress, amount)
      setAirdropMessage(`Airdrop requested! Confirming...`)
      setTransactions(prev => [{
        id: `tx-airdrop-${Date.now()}`,
        type: 'Airdrop' as TxnType,
        amount,
        status: 'Pending' as TxnStatus,
        timestamp: new Date().toISOString(),
        description: `Devnet airdrop ${amount} SOL`,
        signature: sig,
      }, ...prev])

      const confirmed = await confirmTransaction(sig)
      if (confirmed) {
        setAirdropMessage(`Airdrop of ${amount} SOL confirmed!`)
        setTransactions(prev => prev.map(t =>
          t.signature === sig ? { ...t, status: 'Confirmed' as TxnStatus } : t
        ))
        await fetchBalance()
      } else {
        setAirdropMessage('Airdrop confirmation timed out. Balance may update shortly.')
        setTransactions(prev => prev.map(t =>
          t.signature === sig ? { ...t, status: 'Failed' as TxnStatus } : t
        ))
      }
    } catch (err: any) {
      setAirdropMessage(err?.message?.includes('429')
        ? 'Rate limited. Wait a moment and try again.'
        : `Airdrop failed: ${err?.message || 'Unknown error'}`)
    } finally {
      setAirdropLoading(false)
      setTimeout(() => setAirdropMessage(''), 8000)
    }
  }, [walletAddress, fetchBalance])

  // --------------------------------------------------------
  // DEPOSIT / WITHDRAW (Simulated escrow - real balance tracking)
  // --------------------------------------------------------
  const handleDeposit = useCallback(async () => {
    const amt = parseFloat(depositAmount)
    if (isNaN(amt) || amt <= 0 || amt > walletBalance) return
    setDepositLoading(true)
    try {
      // In a production app, this would be an on-chain transfer to an escrow PDA
      // For devnet demo, we simulate the escrow locally while tracking real wallet balance
      setEscrowBalance(prev => prev + amt)
      setWalletBalance(prev => prev - amt)
      setTransactions(prev => [{
        id: `tx-${Date.now()}`,
        type: 'Deposit',
        amount: amt,
        status: 'Confirmed',
        timestamp: new Date().toISOString(),
        description: `Deposited ${amt} SOL to escrow`,
      }, ...prev])
      setDepositAmount('')
      setShowDeposit(false)
    } finally {
      setDepositLoading(false)
    }
  }, [depositAmount, walletBalance])

  const handleWithdraw = useCallback(async () => {
    const amt = parseFloat(withdrawAmount)
    if (isNaN(amt) || amt <= 0 || amt > escrowBalance) return
    setWithdrawLoading(true)
    try {
      setEscrowBalance(prev => prev - amt)
      setWalletBalance(prev => prev + amt)
      setTransactions(prev => [{
        id: `tx-${Date.now()}`,
        type: 'Withdrawal',
        amount: -amt,
        status: 'Confirmed',
        timestamp: new Date().toISOString(),
        description: `Withdrew ${amt} SOL from escrow`,
      }, ...prev])
      setWithdrawAmount('')
      setShowWithdraw(false)
    } finally {
      setWithdrawLoading(false)
    }
  }, [withdrawAmount, escrowBalance])

  // --------------------------------------------------------
  // GAMEPLAY SIMULATION (Commit-Reveal Pattern)
  // --------------------------------------------------------
  const currentWager = useMemo(() => {
    if (selectedTier !== null) return selectedTier
    const c = parseFloat(customTier)
    return isNaN(c) || c <= 0 ? 0 : c
  }, [selectedTier, customTier])

  const findMatch = useCallback(() => {
    if (currentWager <= 0) {
      setPlayError('Select a wager tier first')
      return
    }
    if (currentWager > escrowBalance) {
      setPlayError('Insufficient escrow balance. Deposit SOL first.')
      return
    }
    setPlayError('')
    setMatchState('waiting')
    setFairnessResult(null)
    setFairnessError('')
    const waitTime = 3000 + Math.random() * 2000
    setTimeout(() => {
      // Generate a fake devnet address as opponent
      const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
      let addr = ''
      for (let i = 0; i < 44; i++) addr += chars[Math.floor(Math.random() * chars.length)]
      setOpponent(addr)
      setMatchState('matched')
    }, waitTime)
  }, [currentWager, escrowBalance])

  const chooseAndFlip = useCallback((choice: CoinSide) => {
    setPlayerChoice(choice)
    setMatchState('flipping')
    setRevealTimer(30)
    revealIntervalRef.current = setInterval(() => {
      setRevealTimer(prev => {
        if (prev <= 1) {
          if (revealIntervalRef.current) clearInterval(revealIntervalRef.current)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    const nonce = `${Math.floor(Math.random() * 999999)}`
    const commitHash = generateCommitHash(choice, nonce)

    setTimeout(() => {
      if (revealIntervalRef.current) clearInterval(revealIntervalRef.current)
      const coinResult: CoinSide = Math.random() > 0.5 ? 'Heads' : 'Tails'
      setFlipResult(coinResult)
      const won = coinResult === choice
      const outcome: MatchOutcome = won ? 'Win' : 'Loss'
      setMatchOutcome(outcome)
      setMatchState('result')

      if (won) {
        const payout = currentWager * 2 * 0.975
        setEscrowBalance(prev => prev - currentWager + payout)
        setTransactions(prev => [{
          id: `tx-${Date.now()}`,
          type: 'Payout',
          amount: payout,
          status: 'Confirmed',
          timestamp: new Date().toISOString(),
          description: `Won ${currentWager} SOL match (2.5% fee)`,
        }, {
          id: `tx-${Date.now() - 1}`,
          type: 'Wager Lock',
          amount: -currentWager,
          status: 'Confirmed',
          timestamp: new Date().toISOString(),
          description: `${currentWager} SOL tier match`,
        }, ...prev])
      } else {
        setEscrowBalance(prev => prev - currentWager)
        setTransactions(prev => [{
          id: `tx-${Date.now()}`,
          type: 'Wager Lock',
          amount: -currentWager,
          status: 'Confirmed',
          timestamp: new Date().toISOString(),
          description: `Lost ${currentWager} SOL match`,
        }, ...prev])
      }

      const wins = matchHistory.filter(m => m.outcome === 'Win').length
      const newMatch: MatchRecord = {
        id: `match-${Date.now()}`,
        opponent: truncateAddress(opponent),
        wager: currentWager,
        outcome,
        timestamp: new Date().toISOString(),
        tier: currentWager,
        playerChoice: choice,
        result: coinResult,
        commitHash,
        nonce,
        streak: won ? wins + 1 : 0,
      }
      setMatchHistory(prev => [newMatch, ...prev])
    }, 2500)
  }, [currentWager, opponent, matchHistory])

  const resetMatch = useCallback(() => {
    setMatchState('idle')
    setOpponent('')
    setPlayerChoice(null)
    setFlipResult(null)
    setMatchOutcome(null)
    setFairnessResult(null)
    setFairnessError('')
    setRevealTimer(30)
  }, [])

  // --------------------------------------------------------
  // AGENT CALLS
  // --------------------------------------------------------
  const verifyFairness = useCallback(async () => {
    if (matchHistory.length === 0) return
    const lastMatch = matchHistory[0]
    setFairnessLoading(true)
    setFairnessError('')
    setActiveAgentId(FAIRNESS_AGENT_ID)
    try {
      const message = `Verify fairness for this coin flip duel on Solana Devnet: Commit hash: ${lastMatch.commitHash}, Reveal value: ${lastMatch.result}, Nonce: ${lastMatch.nonce}, Player chose: ${lastMatch.playerChoice}, Result: ${lastMatch.result}, Outcome: ${lastMatch.outcome}, Wager: ${lastMatch.wager} SOL, Player wallet: ${truncateAddress(walletAddress)}, Opponent wallet: ${lastMatch.opponent}`
      const result = await callAIAgent(message, FAIRNESS_AGENT_ID)
      if (result.success) {
        const explanation = result.response?.result?.explanation || extractText(result.response) || 'No explanation available.'
        const verdict = result.response?.result?.verdict || ''
        setFairnessResult({ explanation, verdict })
      } else {
        setFairnessError(result.error || 'Failed to verify fairness')
      }
    } catch {
      setFairnessError('Network error verifying fairness')
    } finally {
      setFairnessLoading(false)
      setActiveAgentId(null)
    }
  }, [matchHistory, walletAddress])

  const getMatchInsight = useCallback(async (matchId: string) => {
    const match = matchHistory.find(m => m.id === matchId)
    if (!match) return
    setInsightMap(prev => ({ ...prev, [matchId]: { summary: '', quip: '', loading: true } }))
    setInsightError('')
    setActiveAgentId(MATCH_INSIGHT_AGENT_ID)
    try {
      const wins = matchHistory.filter(m => m.outcome === 'Win').length
      const losses = matchHistory.filter(m => m.outcome === 'Loss').length
      const matchContext = `Match data: Wager ${match.wager} SOL on Solana Devnet, Outcome: ${match.outcome}, Opponent: ${match.opponent}, Player streak: ${match.streak} wins, Total record: ${wins}W-${losses}L, Player wallet: ${truncateAddress(walletAddress)}`
      const result = await callAIAgent(matchContext, MATCH_INSIGHT_AGENT_ID)
      if (result.success) {
        const summary = result.response?.result?.summary || extractText(result.response) || 'No insight available.'
        const quip = result.response?.result?.quip || ''
        setInsightMap(prev => ({ ...prev, [matchId]: { summary, quip, loading: false } }))
      } else {
        setInsightMap(prev => ({ ...prev, [matchId]: { summary: '', quip: '', loading: false } }))
        setInsightError(result.error || 'Failed to get insight')
      }
    } catch {
      setInsightMap(prev => ({ ...prev, [matchId]: { summary: '', quip: '', loading: false } }))
      setInsightError('Network error fetching insight')
    } finally {
      setActiveAgentId(null)
    }
  }, [matchHistory, walletAddress])

  const sendChatMessage = useCallback(async () => {
    if (!chatInput.trim()) return
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: chatInput.trim(),
      timestamp: new Date().toISOString(),
    }
    setChatMessages(prev => [...prev, userMsg])
    const question = chatInput.trim()
    setChatInput('')
    setChatLoading(true)
    setChatError('')
    setActiveAgentId(WALLET_AGENT_ID)
    try {
      const recentTxns = transactions.slice(0, 5).map(t => ({ type: t.type, amount: t.amount, status: t.status }))
      const walletContext = `Wallet state on Solana Devnet: Address ${walletAddress}, On-chain balance: ${walletBalance.toFixed(4)} SOL, Escrow balance: ${escrowBalance.toFixed(4)} SOL, Network: Devnet (${networkStatus}), Recent transactions: ${JSON.stringify(recentTxns)}. User question: ${question}`
      const result = await callAIAgent(walletContext, WALLET_AGENT_ID)
      if (result.success) {
        const text = result.response?.result?.text || extractText(result.response) || 'I could not process your request.'
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now() + 1}`,
          role: 'assistant',
          content: text,
          timestamp: new Date().toISOString(),
        }
        setChatMessages(prev => [...prev, assistantMsg])
      } else {
        setChatError(result.error || 'Failed to get response')
      }
    } catch {
      setChatError('Network error')
    } finally {
      setChatLoading(false)
      setActiveAgentId(null)
    }
  }, [chatInput, walletAddress, walletBalance, escrowBalance, transactions, networkStatus])

  // --------------------------------------------------------
  // STATS (Derived)
  // --------------------------------------------------------
  const stats = useMemo(() => {
    const total = matchHistory.length
    const wins = matchHistory.filter(m => m.outcome === 'Win').length
    const losses = matchHistory.filter(m => m.outcome === 'Loss').length
    const forfeits = matchHistory.filter(m => m.outcome === 'Forfeit').length
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0'
    let totalEarnings = 0
    matchHistory.forEach(m => {
      if (m.outcome === 'Win') totalEarnings += m.wager * 0.975
      else if (m.outcome === 'Loss') totalEarnings -= m.wager
    })
    let streak = 0
    for (const m of matchHistory) {
      if (m.outcome === 'Win') streak++
      else break
    }
    return { total, wins, losses, forfeits, winRate, totalEarnings: totalEarnings.toFixed(3), streak }
  }, [matchHistory])

  // --------------------------------------------------------
  // FILTERED HISTORY
  // --------------------------------------------------------
  const filteredHistory = useMemo(() => {
    let filtered = matchHistory
    if (historyTierFilter !== null) {
      filtered = filtered.filter(m => m.tier === historyTierFilter)
    }
    if (historyOutcomeFilter !== 'All') {
      filtered = filtered.filter(m => m.outcome === historyOutcomeFilter)
    }
    return filtered
  }, [matchHistory, historyTierFilter, historyOutcomeFilter])

  // ============================================================
  // RENDER TABS
  // ============================================================

  // ---------- PLAY TAB ----------
  function renderPlayTab() {
    return (
      <div className="space-y-4 pb-4">
        {/* Wallet Connection Banner */}
        {!walletConnected && (
          <GlassCard glowColor={NEON_CYAN_GLOW} className="text-center">
            <HiOutlineWallet className="w-10 h-10 mx-auto mb-3" style={{ color: 'hsl(180 100% 50%)' }} />
            <h3 className="text-lg font-bold tracking-wider mb-1">Connect Phantom Wallet</h3>
            <p className="text-xs text-muted-foreground mb-2">Connect your Phantom wallet on Solana Devnet to start playing</p>

            <div className="flex items-center justify-center gap-2 mb-3">
              <HiGlobeAlt className="w-3 h-3" style={{ color: networkStatus === 'connected' ? 'hsl(120 100% 50%)' : 'hsl(0 100% 55%)' }} />
              <span className="text-xs" style={{ color: networkStatus === 'connected' ? 'hsl(120 100% 50%)' : 'hsl(0 100% 55%)' }}>
                Devnet {networkStatus === 'connected' ? 'Online' : networkStatus === 'checking' ? 'Checking...' : 'Offline'}
              </span>
            </div>

            {isPhantomInstalled ? (
              <Button
                onClick={connectWallet}
                className="w-full font-bold tracking-wider"
                style={{ background: 'hsl(180 100% 50%)', color: 'hsl(260 30% 6%)', boxShadow: NEON_CYAN_GLOW }}
              >
                <HiLink className="w-4 h-4 mr-2" /> Connect Phantom
              </Button>
            ) : (
              <div>
                <p className="text-xs mb-2" style={{ color: 'hsl(60 100% 50%)' }}>
                  Phantom wallet not detected
                </p>
                <a
                  href="https://phantom.app/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-4 py-2 rounded text-sm font-semibold tracking-wider"
                  style={{ background: 'hsl(300 80% 50%)', color: 'white', boxShadow: NEON_MAGENTA_GLOW }}
                >
                  Install Phantom <HiArrowRightOnRectangle className="w-4 h-4" />
                </a>
              </div>
            )}

            {connectionError && (
              <p className="text-xs mt-2" style={{ color: 'hsl(0 100% 55%)' }}>
                <HiExclamationTriangle className="w-3 h-3 inline mr-1" />{connectionError}
              </p>
            )}
          </GlassCard>
        )}

        {/* Escrow Balance Card */}
        {walletConnected && (
          <GlassCard glowColor={NEON_CYAN_GLOW}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Escrow Balance</span>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => handleAirdrop(1)}
                  disabled={airdropLoading}
                  size="sm"
                  variant="outline"
                  className="text-xs tracking-wider h-6 px-2"
                  style={{ borderColor: 'hsl(60 100% 50% / 0.3)', color: 'hsl(60 100% 50%)' }}
                >
                  {airdropLoading ? <NeonSpinner size={12} /> : <><HiPlus className="w-3 h-3 mr-1" />Airdrop</>}
                </Button>
                <HiBolt className="w-4 h-4" style={{ color: 'hsl(180 100% 50%)' }} />
              </div>
            </div>
            {airdropMessage && (
              <p className="text-xs mb-2" style={{ color: airdropMessage.includes('failed') || airdropMessage.includes('Rate') ? 'hsl(0 100% 55%)' : 'hsl(120 100% 50%)' }}>
                {airdropMessage}
              </p>
            )}
            <div className="text-3xl font-bold tracking-wider mb-1" style={{ color: 'hsl(180 100% 50%)' }}>
              {escrowBalance.toFixed(3)} <span className="text-lg text-muted-foreground">SOL</span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Wallet: {walletBalance.toFixed(4)} SOL {balanceLoading && <HiArrowPath className="w-3 h-3 inline animate-spin" />}
            </p>
            <div className="flex gap-2">
              {!showDeposit && !showWithdraw && (
                <>
                  <Button
                    onClick={() => setShowDeposit(true)}
                    className="flex-1 text-xs font-semibold tracking-wider"
                    style={{ background: 'hsl(120 100% 50% / 0.15)', color: 'hsl(120 100% 60%)', border: '1px solid hsl(120 100% 50% / 0.3)' }}
                    variant="outline"
                  >
                    <HiPlus className="w-3 h-3 mr-1" /> Deposit
                  </Button>
                  <Button
                    onClick={() => setShowWithdraw(true)}
                    className="flex-1 text-xs font-semibold tracking-wider"
                    variant="outline"
                    style={{ background: 'hsl(0 100% 55% / 0.15)', color: 'hsl(0 100% 65%)', border: '1px solid hsl(0 100% 55% / 0.3)' }}
                  >
                    <HiMinus className="w-3 h-3 mr-1" /> Withdraw
                  </Button>
                </>
              )}
              {showDeposit && (
                <div className="flex-1 flex gap-2">
                  <Input
                    type="number"
                    placeholder="SOL amount"
                    value={depositAmount}
                    onChange={e => setDepositAmount(e.target.value)}
                    className="flex-1 text-sm bg-input border-border"
                    step="0.01"
                    min="0.001"
                    style={{ letterSpacing: '0.02em' }}
                  />
                  <Button onClick={handleDeposit} disabled={depositLoading} size="sm" style={{ background: 'hsl(120 100% 50%)', color: 'hsl(260 30% 6%)' }}>
                    {depositLoading ? <NeonSpinner size={14} /> : <HiCheck className="w-4 h-4" />}
                  </Button>
                  <Button onClick={() => { setShowDeposit(false); setDepositAmount('') }} size="sm" variant="ghost">
                    <HiXMark className="w-4 h-4" />
                  </Button>
                </div>
              )}
              {showWithdraw && (
                <div className="flex-1 flex gap-2">
                  <Input
                    type="number"
                    placeholder="SOL amount"
                    value={withdrawAmount}
                    onChange={e => setWithdrawAmount(e.target.value)}
                    className="flex-1 text-sm bg-input border-border"
                    step="0.01"
                    min="0.001"
                    style={{ letterSpacing: '0.02em' }}
                  />
                  <Button onClick={handleWithdraw} disabled={withdrawLoading} size="sm" style={{ background: 'hsl(0 100% 55%)', color: 'white' }}>
                    {withdrawLoading ? <NeonSpinner size={14} /> : <HiCheck className="w-4 h-4" />}
                  </Button>
                  <Button onClick={() => { setShowWithdraw(false); setWithdrawAmount('') }} size="sm" variant="ghost">
                    <HiXMark className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </GlassCard>
        )}

        {/* Tier Selector */}
        {walletConnected && matchState === 'idle' && (
          <GlassCard>
            <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold block mb-3">Wager Tier</span>
            <div className="flex gap-2 flex-wrap">
              {[0.1, 0.5, 1, 2].map(tier => (
                <button
                  key={tier}
                  onClick={() => { setSelectedTier(tier); setCustomTier('') }}
                  className="px-4 py-2 rounded text-sm font-bold tracking-wider transition-all duration-200"
                  style={{
                    background: selectedTier === tier ? 'hsl(180 100% 50%)' : 'hsl(260 20% 15%)',
                    color: selectedTier === tier ? 'hsl(260 30% 6%)' : 'hsl(180 100% 70%)',
                    boxShadow: selectedTier === tier ? NEON_CYAN_GLOW : 'none',
                    border: `1px solid ${selectedTier === tier ? 'hsl(180 100% 50%)' : 'hsl(180 60% 30% / 0.5)'}`,
                  }}
                >
                  {tier} SOL
                </button>
              ))}
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  placeholder="Custom"
                  value={customTier}
                  onChange={e => { setCustomTier(e.target.value); setSelectedTier(null) }}
                  className="w-20 text-xs bg-input border-border h-9"
                  step="0.01"
                  style={{ letterSpacing: '0.02em' }}
                />
                <span className="text-xs text-muted-foreground">SOL</span>
              </div>
            </div>
          </GlassCard>
        )}

        {/* Match Arena */}
        <GlassCard glowColor={matchState !== 'idle' ? NEON_MAGENTA_GLOW : undefined}>
          {matchState === 'idle' && walletConnected && (
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ background: 'hsl(260 20% 15%)', border: '1px solid hsl(180 60% 30% / 0.5)' }}>
                <HiOutlinePlay className="w-8 h-8" style={{ color: 'hsl(180 100% 50%)' }} />
              </div>
              <p className="text-sm text-muted-foreground tracking-wide">Select a tier and find your match!</p>
              <p className="text-xs text-muted-foreground mt-1">Playing on Solana Devnet</p>
              {playError && <p className="text-xs mt-2" style={{ color: 'hsl(0 100% 55%)' }}><HiExclamationTriangle className="w-3 h-3 inline mr-1" />{playError}</p>}
            </div>
          )}

          {matchState === 'idle' && !walletConnected && (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground tracking-wide">Connect your Phantom wallet to start playing</p>
            </div>
          )}

          {matchState === 'waiting' && (
            <div className="text-center py-8">
              <NeonSpinner size={48} />
              <p className="mt-4 text-sm font-semibold tracking-wider animate-pulse" style={{ color: 'hsl(180 100% 50%)' }}>Searching for opponent...</p>
              <p className="text-xs text-muted-foreground mt-1 tracking-wide">{currentWager} SOL Tier</p>
            </div>
          )}

          {matchState === 'matched' && (
            <div className="text-center py-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Opponent Found</p>
              <p className="text-lg font-bold tracking-wider mb-1" style={{ color: 'hsl(300 80% 50%)' }}>{truncateAddress(opponent)}</p>
              <p className="text-xs text-muted-foreground mb-1 tracking-wide break-all opacity-50">{opponent}</p>
              <p className="text-sm text-muted-foreground mb-4 tracking-wide">Wager: {currentWager} SOL</p>
              <Separator className="mb-4" style={{ background: 'hsl(180 60% 30% / 0.3)' }} />
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Choose your side</p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => chooseAndFlip('Heads')}
                  className="w-24 h-24 rounded-full text-lg font-bold tracking-wider transition-all duration-200 hover:scale-105"
                  style={{
                    background: 'linear-gradient(135deg, hsl(180 100% 50% / 0.2), hsl(180 100% 50% / 0.05))',
                    border: '2px solid hsl(180 100% 50% / 0.5)',
                    color: 'hsl(180 100% 50%)',
                    boxShadow: NEON_CYAN_GLOW,
                  }}
                >
                  Heads
                </button>
                <button
                  onClick={() => chooseAndFlip('Tails')}
                  className="w-24 h-24 rounded-full text-lg font-bold tracking-wider transition-all duration-200 hover:scale-105"
                  style={{
                    background: 'linear-gradient(135deg, hsl(300 80% 50% / 0.2), hsl(300 80% 50% / 0.05))',
                    border: '2px solid hsl(300 80% 50% / 0.5)',
                    color: 'hsl(300 80% 50%)',
                    boxShadow: NEON_MAGENTA_GLOW,
                  }}
                >
                  Tails
                </button>
              </div>
            </div>
          )}

          {matchState === 'flipping' && (
            <div className="py-4">
              <CoinFlipVisual isFlipping={true} result={null} />
              <div className="text-center mt-2">
                <p className="text-xs text-muted-foreground tracking-wide">Reveal timer: {revealTimer}s</p>
                <Progress value={(revealTimer / 30) * 100} className="mt-2 h-1" />
              </div>
            </div>
          )}

          {matchState === 'result' && (
            <div className="py-4">
              <CoinFlipVisual isFlipping={false} result={flipResult} />
              <div className="text-center mt-2">
                {matchOutcome === 'Win' ? (
                  <div>
                    <p className="text-2xl font-bold tracking-wider" style={{ color: 'hsl(120 100% 50%)', textShadow: '0 0 20px hsl(120 100% 50% / 0.5)' }}>
                      YOU WIN!
                    </p>
                    <p className="text-sm text-muted-foreground mt-1 tracking-wide">
                      +{(currentWager * 0.975).toFixed(4)} SOL (after 2.5% fee)
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-2xl font-bold tracking-wider" style={{ color: 'hsl(0 100% 55%)', textShadow: '0 0 20px hsl(0 100% 55% / 0.5)' }}>
                      YOU LOST
                    </p>
                    <p className="text-sm text-muted-foreground mt-1 tracking-wide">
                      -{currentWager} SOL
                    </p>
                  </div>
                )}
                <div className="flex gap-2 justify-center mt-4">
                  <Button
                    onClick={verifyFairness}
                    disabled={fairnessLoading}
                    className="text-xs font-semibold tracking-wider"
                    variant="outline"
                    style={{ borderColor: 'hsl(300 80% 50% / 0.5)', color: 'hsl(300 80% 50%)' }}
                  >
                    {fairnessLoading ? <NeonSpinner size={14} /> : <HiShieldCheck className="w-4 h-4 mr-1" />}
                    Verify Fairness
                  </Button>
                  <Button
                    onClick={resetMatch}
                    className="text-xs font-semibold tracking-wider"
                    style={{ background: 'hsl(180 100% 50%)', color: 'hsl(260 30% 6%)' }}
                  >
                    <HiArrowPath className="w-4 h-4 mr-1" /> Play Again
                  </Button>
                </div>
              </div>

              {/* Fairness Result */}
              {fairnessResult && (
                <GlassCard className="mt-4" glowColor={NEON_MAGENTA_GLOW}>
                  <div className="flex items-center gap-2 mb-2">
                    <HiShieldCheck className="w-4 h-4" style={{ color: 'hsl(300 80% 50%)' }} />
                    <span className="text-xs font-semibold tracking-wider uppercase" style={{ color: 'hsl(300 80% 50%)' }}>Fairness Verification</span>
                  </div>
                  {fairnessResult.verdict && (
                    <Badge className="mb-2 text-xs" style={{ background: 'hsl(120 100% 50% / 0.15)', color: 'hsl(120 100% 60%)', border: '1px solid hsl(120 100% 50% / 0.3)' }}>
                      {fairnessResult.verdict}
                    </Badge>
                  )}
                  <div className="text-sm text-muted-foreground">{renderMarkdown(fairnessResult.explanation)}</div>
                </GlassCard>
              )}
              {fairnessError && (
                <p className="text-xs mt-2 text-center" style={{ color: 'hsl(0 100% 55%)' }}>
                  <HiExclamationTriangle className="w-3 h-3 inline mr-1" />{fairnessError}
                </p>
              )}
            </div>
          )}
        </GlassCard>

        {/* Find Match Button */}
        {walletConnected && matchState === 'idle' && (
          <Button
            onClick={findMatch}
            className="w-full py-6 text-lg font-bold tracking-wider"
            style={{
              background: 'linear-gradient(135deg, hsl(180 100% 50%), hsl(300 80% 50%))',
              color: 'hsl(260 30% 6%)',
              boxShadow: `${NEON_CYAN_GLOW}, ${NEON_MAGENTA_GLOW}`,
            }}
          >
            <HiOutlinePlay className="w-5 h-5 mr-2" /> Find Match
          </Button>
        )}
      </div>
    )
  }

  // ---------- DASHBOARD TAB ----------
  function renderDashboardTab() {
    return (
      <div className="space-y-4 pb-4">
        {/* Stat Grid */}
        <div className="grid grid-cols-2 gap-3">
          <GlassCard glowColor={NEON_CYAN_GLOW}>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Total Duels</p>
            <p className="text-2xl font-bold tracking-wider mt-1" style={{ color: 'hsl(180 100% 50%)' }}>{stats.total}</p>
          </GlassCard>
          <GlassCard glowColor={NEON_MAGENTA_GLOW}>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Win Rate</p>
            <p className="text-2xl font-bold tracking-wider mt-1" style={{ color: 'hsl(300 80% 50%)' }}>{stats.winRate}%</p>
          </GlassCard>
          <GlassCard glowColor={parseFloat(stats.totalEarnings) >= 0 ? NEON_GREEN_GLOW : NEON_RED_GLOW}>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Earnings</p>
            <p className="text-2xl font-bold tracking-wider mt-1" style={{ color: parseFloat(stats.totalEarnings) >= 0 ? 'hsl(120 100% 50%)' : 'hsl(0 100% 55%)' }}>
              {parseFloat(stats.totalEarnings) >= 0 ? '+' : ''}{stats.totalEarnings}
            </p>
            <p className="text-xs text-muted-foreground">SOL</p>
          </GlassCard>
          <GlassCard glowColor={stats.streak > 0 ? '0 0 10px hsl(60 100% 50% / 0.3)' : undefined}>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Streak</p>
            <div className="flex items-center gap-1 mt-1">
              <p className="text-2xl font-bold tracking-wider" style={{ color: 'hsl(60 100% 50%)' }}>{stats.streak}</p>
              {stats.streak > 0 && <HiTrophy className="w-5 h-5" style={{ color: 'hsl(60 100% 50%)' }} />}
            </div>
          </GlassCard>
        </div>

        {/* Wallet Info */}
        {walletConnected && (
          <GlassCard>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Connected Wallet</p>
                <p className="text-sm font-mono tracking-wider mt-1 break-all" style={{ color: 'hsl(180 100% 70%)' }}>{walletAddress}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Network</p>
                <p className="text-xs font-semibold" style={{ color: 'hsl(60 100% 50%)' }}>Solana Devnet</p>
              </div>
            </div>
          </GlassCard>
        )}

        {/* Earnings Chart */}
        <GlassCard>
          <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold block mb-3">Earnings Over Time</span>
          {chartData.length > 0 ? (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="neonGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(180, 100%, 50%)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(180, 100%, 50%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(260, 20%, 20%)" />
                  <XAxis dataKey="match" tick={{ fill: 'hsl(180, 50%, 45%)', fontSize: 10 }} axisLine={{ stroke: 'hsl(260, 20%, 20%)' }} />
                  <YAxis tick={{ fill: 'hsl(180, 50%, 45%)', fontSize: 10 }} axisLine={{ stroke: 'hsl(260, 20%, 20%)' }} />
                  <Tooltip
                    contentStyle={{ background: 'hsl(260, 25%, 9%)', border: '1px solid hsl(180, 60%, 30%)', borderRadius: '4px', color: 'hsl(180, 100%, 70%)' }}
                    labelStyle={{ color: 'hsl(180, 100%, 50%)' }}
                  />
                  <Area type="monotone" dataKey="earnings" stroke="hsl(180, 100%, 50%)" fill="url(#neonGrad)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-48 flex items-center justify-center">
              <p className="text-sm text-muted-foreground tracking-wide">No match data yet. Play some duels!</p>
            </div>
          )}
        </GlassCard>

        {/* Recent Activity */}
        <GlassCard>
          <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold block mb-3">Recent Activity</span>
          {matchHistory.length > 0 ? (
            <div className="space-y-2">
              {matchHistory.slice(0, 5).map(match => (
                <div
                  key={match.id}
                  className="flex items-center justify-between p-2 rounded"
                  style={{ background: 'hsl(260 20% 12% / 0.6)', border: '1px solid hsl(180 60% 30% / 0.2)' }}
                >
                  <div className="flex items-center gap-2">
                    <OutcomeBadge outcome={match.outcome} />
                    <span className="text-xs text-muted-foreground tracking-wide">vs {match.opponent}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-semibold tracking-wider">{match.wager} SOL</span>
                    <p className="text-xs text-muted-foreground">{formatTime(match.timestamp)}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4 tracking-wide">No matches yet</p>
          )}
        </GlassCard>

        <AgentStatusPanel activeAgentId={activeAgentId} />
      </div>
    )
  }

  // ---------- HISTORY TAB ----------
  function renderHistoryTab() {
    return (
      <div className="space-y-4 pb-4">
        {/* Filter Bar */}
        <GlassCard>
          <div className="space-y-3">
            <div>
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold block mb-2">Tier Filter</span>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setHistoryTierFilter(null)}
                  className="px-3 py-1 rounded text-xs font-semibold tracking-wider transition-all"
                  style={{
                    background: historyTierFilter === null ? 'hsl(180 100% 50%)' : 'hsl(260 20% 15%)',
                    color: historyTierFilter === null ? 'hsl(260 30% 6%)' : 'hsl(180 100% 70%)',
                    border: `1px solid ${historyTierFilter === null ? 'hsl(180 100% 50%)' : 'hsl(180 60% 30% / 0.5)'}`,
                  }}
                >
                  All
                </button>
                {[0.1, 0.5, 1, 2].map(t => (
                  <button
                    key={t}
                    onClick={() => setHistoryTierFilter(t)}
                    className="px-3 py-1 rounded text-xs font-semibold tracking-wider transition-all"
                    style={{
                      background: historyTierFilter === t ? 'hsl(180 100% 50%)' : 'hsl(260 20% 15%)',
                      color: historyTierFilter === t ? 'hsl(260 30% 6%)' : 'hsl(180 100% 70%)',
                      border: `1px solid ${historyTierFilter === t ? 'hsl(180 100% 50%)' : 'hsl(180 60% 30% / 0.5)'}`,
                    }}
                  >
                    {t} SOL
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold block mb-2">Outcome</span>
              <div className="flex gap-2 flex-wrap">
                {(['All', 'Win', 'Loss', 'Forfeit'] as const).map(o => (
                  <button
                    key={o}
                    onClick={() => setHistoryOutcomeFilter(o === 'All' ? 'All' : o as MatchOutcome)}
                    className="px-3 py-1 rounded text-xs font-semibold tracking-wider transition-all"
                    style={{
                      background: historyOutcomeFilter === o ? 'hsl(300 80% 50%)' : 'hsl(260 20% 15%)',
                      color: historyOutcomeFilter === o ? 'white' : 'hsl(180 100% 70%)',
                      border: `1px solid ${historyOutcomeFilter === o ? 'hsl(300 80% 50%)' : 'hsl(180 60% 30% / 0.5)'}`,
                    }}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </GlassCard>

        {/* Match Cards */}
        {filteredHistory.length > 0 ? (
          <div className="space-y-3">
            {filteredHistory.map(match => {
              const insight = insightMap[match.id]
              return (
                <div key={match.id}>
                  <GlassCard>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <OutcomeBadge outcome={match.outcome} />
                        <span className="text-sm font-semibold tracking-wider">vs {match.opponent}</span>
                      </div>
                      <span className="text-sm font-bold tracking-wider" style={{ color: 'hsl(180 100% 50%)' }}>{match.wager} SOL</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground tracking-wide">{formatDate(match.timestamp)}</span>
                      <span className="text-xs text-muted-foreground tracking-wide">
                        {match.playerChoice} vs {match.result}
                      </span>
                    </div>
                    <div className="mt-3">
                      <Button
                        onClick={() => getMatchInsight(match.id)}
                        disabled={insight?.loading === true}
                        size="sm"
                        variant="outline"
                        className="text-xs tracking-wider w-full"
                        style={{ borderColor: 'hsl(60 100% 50% / 0.3)', color: 'hsl(60 100% 50%)' }}
                      >
                        {insight?.loading ? <NeonSpinner size={14} /> : <HiLightBulb className="w-3 h-3 mr-1" />}
                        Get Insight
                      </Button>
                    </div>
                  </GlassCard>

                  {/* Insight Display */}
                  {insight && !insight.loading && (insight.summary || insight.quip) && (
                    <div
                      className="ml-4 mt-1 p-3 rounded"
                      style={{
                        background: 'hsl(260 22% 12% / 0.9)',
                        border: '1px solid hsl(60 100% 50% / 0.2)',
                        borderLeft: '3px solid hsl(60 100% 50%)',
                      }}
                    >
                      <div className="flex items-center gap-1 mb-2">
                        <HiLightBulb className="w-3 h-3" style={{ color: 'hsl(60 100% 50%)' }} />
                        <span className="text-xs font-semibold tracking-wider uppercase" style={{ color: 'hsl(60 100% 50%)' }}>Match Insight</span>
                      </div>
                      {insight.summary && (
                        <div className="text-sm text-muted-foreground">{renderMarkdown(insight.summary)}</div>
                      )}
                      {insight.quip && (
                        <p className="text-xs mt-2 italic" style={{ color: 'hsl(300 80% 70%)' }}>
                          &quot;{insight.quip}&quot;
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <GlassCard className="text-center py-8">
            <HiOutlineClock className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground tracking-wide">No matches found</p>
            {matchHistory.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">Play some duels to see your history here</p>
            )}
          </GlassCard>
        )}

        {insightError && (
          <p className="text-xs text-center" style={{ color: 'hsl(0 100% 55%)' }}>
            <HiExclamationTriangle className="w-3 h-3 inline mr-1" />{insightError}
          </p>
        )}
      </div>
    )
  }

  // ---------- WALLET TAB ----------
  function renderWalletTab() {
    return (
      <div className="space-y-4 pb-4">
        {/* Balance Cards */}
        <div className="grid grid-cols-2 gap-3">
          <GlassCard glowColor={NEON_CYAN_GLOW}>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">On-Chain</p>
            <p className="text-xl font-bold tracking-wider mt-1" style={{ color: 'hsl(180 100% 50%)' }}>
              {walletBalance.toFixed(4)}
              {balanceLoading && <HiArrowPath className="w-3 h-3 inline ml-1 animate-spin" />}
            </p>
            <p className="text-xs text-muted-foreground">SOL (Devnet)</p>
          </GlassCard>
          <GlassCard glowColor={NEON_MAGENTA_GLOW}>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Escrow</p>
            <p className="text-xl font-bold tracking-wider mt-1" style={{ color: 'hsl(300 80% 50%)' }}>{escrowBalance.toFixed(4)}</p>
            <p className="text-xs text-muted-foreground">SOL</p>
          </GlassCard>
        </div>

        {/* Wallet Address & Network */}
        {walletConnected && (
          <GlassCard>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Wallet Address</span>
                <Badge className="text-xs" style={{ background: 'hsl(60 100% 50% / 0.15)', color: 'hsl(60 100% 60%)', border: '1px solid hsl(60 100% 50% / 0.3)' }}>
                  Devnet
                </Badge>
              </div>
              <p className="text-xs font-mono break-all" style={{ color: 'hsl(180 100% 70%)' }}>{walletAddress}</p>
              <div className="flex gap-2">
                <Button
                  onClick={() => handleAirdrop(1)}
                  disabled={airdropLoading}
                  size="sm"
                  variant="outline"
                  className="flex-1 text-xs tracking-wider"
                  style={{ borderColor: 'hsl(60 100% 50% / 0.3)', color: 'hsl(60 100% 50%)' }}
                >
                  {airdropLoading ? <NeonSpinner size={12} /> : <><HiPlus className="w-3 h-3 mr-1" />Airdrop 1 SOL</>}
                </Button>
                <Button
                  onClick={() => handleAirdrop(2)}
                  disabled={airdropLoading}
                  size="sm"
                  variant="outline"
                  className="flex-1 text-xs tracking-wider"
                  style={{ borderColor: 'hsl(60 100% 50% / 0.3)', color: 'hsl(60 100% 50%)' }}
                >
                  {airdropLoading ? <NeonSpinner size={12} /> : <><HiPlus className="w-3 h-3 mr-1" />Airdrop 2 SOL</>}
                </Button>
              </div>
              {airdropMessage && (
                <p className="text-xs" style={{ color: airdropMessage.includes('failed') || airdropMessage.includes('Rate') ? 'hsl(0 100% 55%)' : 'hsl(120 100% 50%)' }}>
                  {airdropMessage}
                </p>
              )}
              <Button
                onClick={fetchBalance}
                disabled={balanceLoading}
                size="sm"
                variant="outline"
                className="w-full text-xs tracking-wider"
                style={{ borderColor: 'hsl(180 60% 30% / 0.5)', color: 'hsl(180 100% 70%)' }}
              >
                <HiArrowPath className={cn("w-3 h-3 mr-1", balanceLoading && "animate-spin")} />
                Refresh Balance
              </Button>
            </div>
          </GlassCard>
        )}

        {/* Quick Actions */}
        <div className="flex gap-2">
          <Button
            onClick={() => { setActiveTab('play'); setShowDeposit(true) }}
            className="flex-1 text-xs font-semibold tracking-wider"
            style={{ background: 'hsl(120 100% 50% / 0.15)', color: 'hsl(120 100% 60%)', border: '1px solid hsl(120 100% 50% / 0.3)' }}
            variant="outline"
          >
            <HiPlus className="w-3 h-3 mr-1" /> Deposit
          </Button>
          <Button
            onClick={() => { setActiveTab('play'); setShowWithdraw(true) }}
            className="flex-1 text-xs font-semibold tracking-wider"
            variant="outline"
            style={{ background: 'hsl(0 100% 55% / 0.15)', color: 'hsl(0 100% 65%)', border: '1px solid hsl(0 100% 55% / 0.3)' }}
          >
            <HiMinus className="w-3 h-3 mr-1" /> Withdraw
          </Button>
        </div>

        {/* Transaction List */}
        <GlassCard>
          <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold block mb-3">Transactions</span>
          {transactions.length > 0 ? (
            <ScrollArea className="h-48">
              <div className="space-y-2 pr-2">
                {transactions.map(txn => (
                  <div
                    key={txn.id}
                    className="flex items-center justify-between p-2 rounded"
                    style={{ background: 'hsl(260 20% 12% / 0.6)', border: '1px solid hsl(180 60% 30% / 0.2)' }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
                        style={{
                          background: txn.amount >= 0
                            ? 'hsl(120 100% 50% / 0.15)'
                            : 'hsl(0 100% 55% / 0.15)',
                        }}
                      >
                        {txn.amount >= 0 ? (
                          <HiArrowDown className="w-3 h-3" style={{ color: 'hsl(120 100% 50%)' }} />
                        ) : (
                          <HiArrowUp className="w-3 h-3" style={{ color: 'hsl(0 100% 55%)' }} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold tracking-wide truncate">{txn.type}</p>
                        <p className="text-xs text-muted-foreground truncate">{txn.description}</p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-2">
                      <p
                        className="text-xs font-bold tracking-wider"
                        style={{ color: txn.amount >= 0 ? 'hsl(120 100% 50%)' : 'hsl(0 100% 55%)' }}
                      >
                        {txn.amount >= 0 ? '+' : ''}{txn.amount.toFixed(4)} SOL
                      </p>
                      <TxnStatusBadge status={txn.status} />
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4 tracking-wide">No transactions yet</p>
          )}
        </GlassCard>

        {/* Chat Widget */}
        <GlassCard glowColor={NEON_CYAN_GLOW}>
          <div className="flex items-center gap-2 mb-3">
            <HiInformationCircle className="w-4 h-4" style={{ color: 'hsl(180 100% 50%)' }} />
            <span className="text-xs font-semibold tracking-wider uppercase" style={{ color: 'hsl(180 100% 50%)' }}>Wallet Assistant</span>
          </div>

          <div
            ref={chatScrollRef}
            className="h-40 overflow-y-auto mb-3 space-y-2 pr-1"
            style={{ scrollbarWidth: 'thin', scrollbarColor: 'hsl(180 60% 30%) transparent' }}
          >
            {chatMessages.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <p className="text-xs text-muted-foreground tracking-wide text-center">
                  Ask me anything about your Solana Devnet wallet, balances, or transactions
                </p>
              </div>
            )}
            {chatMessages.map(msg => (
              <div
                key={msg.id}
                className={cn(
                  'max-w-[85%] p-2 rounded text-xs tracking-wide',
                  msg.role === 'user' ? 'ml-auto' : 'mr-auto'
                )}
                style={{
                  background: msg.role === 'user'
                    ? 'hsl(180 100% 50% / 0.15)'
                    : 'hsl(260 20% 15%)',
                  border: `1px solid ${msg.role === 'user' ? 'hsl(180 100% 50% / 0.3)' : 'hsl(180 60% 30% / 0.2)'}`,
                }}
              >
                {msg.role === 'assistant' ? renderMarkdown(msg.content) : msg.content}
              </div>
            ))}
            {chatLoading && (
              <div className="mr-auto p-2">
                <NeonSpinner size={16} />
              </div>
            )}
          </div>

          {chatError && (
            <p className="text-xs mb-2" style={{ color: 'hsl(0 100% 55%)' }}>
              <HiExclamationTriangle className="w-3 h-3 inline mr-1" />{chatError}
            </p>
          )}

          <div className="flex gap-2">
            <Input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage() } }}
              placeholder="Ask about your wallet..."
              className="flex-1 text-xs bg-input border-border"
              style={{ letterSpacing: '0.02em' }}
              disabled={chatLoading}
            />
            <Button
              onClick={sendChatMessage}
              disabled={chatLoading || !chatInput.trim()}
              size="sm"
              style={{
                background: chatInput.trim() ? 'hsl(180 100% 50%)' : 'hsl(260 20% 15%)',
                color: chatInput.trim() ? 'hsl(260 30% 6%)' : 'hsl(180 50% 45%)',
              }}
            >
              <HiPaperAirplane className="w-4 h-4" />
            </Button>
          </div>
        </GlassCard>

        <AgentStatusPanel activeAgentId={activeAgentId} />
      </div>
    )
  }

  // ============================================================
  // MAIN RENDER
  // ============================================================
  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'play', label: 'Play', icon: <HiOutlinePlay className="w-5 h-5" /> },
    { id: 'dashboard', label: 'Stats', icon: <HiOutlineChartBar className="w-5 h-5" /> },
    { id: 'history', label: 'History', icon: <HiOutlineClock className="w-5 h-5" /> },
    { id: 'wallet', label: 'Wallet', icon: <HiOutlineWallet className="w-5 h-5" /> },
  ]

  return (
    <ErrorBoundary>
      <div
        className="min-h-screen flex flex-col font-sans"
        style={{
          background: 'linear-gradient(135deg, hsl(260 35% 8%) 0%, hsl(280 30% 10%) 50%, hsl(240 25% 8%) 100%)',
          letterSpacing: '0.02em',
        }}
      >
        {/* ========== HEADER ========== */}
        <header
          className="flex items-center justify-between px-4 py-3 sticky top-0 z-40 backdrop-blur-[12px]"
          style={{
            background: 'hsl(260 30% 6% / 0.85)',
            borderBottom: '1px solid hsl(180 60% 30% / 0.2)',
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded flex items-center justify-center font-bold text-sm"
              style={{
                background: 'linear-gradient(135deg, hsl(180 100% 50%), hsl(300 80% 50%))',
                color: 'hsl(260 30% 6%)',
                boxShadow: NEON_CYAN_GLOW,
              }}
            >
              SF
            </div>
            <div>
              <span className="text-sm font-bold tracking-wider block" style={{ color: 'hsl(180 100% 50%)' }}>SolFlip</span>
              <span className="text-xs text-muted-foreground tracking-wide">Devnet</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {walletConnected && (
              <>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground tracking-wider">{truncateAddress(walletAddress)}</p>
                  <p className="text-xs font-semibold tracking-wider" style={{ color: 'hsl(180 100% 50%)' }}>
                    {walletBalance.toFixed(4)} SOL
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{
                      background: networkStatus === 'connected' ? 'hsl(120 100% 50%)' : networkStatus === 'checking' ? 'hsl(60 100% 50%)' : 'hsl(0 100% 55%)',
                      boxShadow: networkStatus === 'connected' ? NEON_GREEN_GLOW : 'none',
                    }}
                  />
                  <HiSignal className="w-3 h-3" style={{ color: networkStatus === 'connected' ? 'hsl(120 100% 50%)' : 'hsl(0 100% 55%)' }} />
                </div>
                <button
                  onClick={disconnectWallet}
                  className="p-1 rounded hover:bg-muted/20 transition-colors"
                  title="Disconnect wallet"
                >
                  <HiArrowRightOnRectangle className="w-4 h-4 text-muted-foreground" />
                </button>
              </>
            )}
          </div>
        </header>

        {/* ========== CONTENT ========== */}
        <main className="flex-1 overflow-y-auto px-4 pt-4 pb-20">
          {activeTab === 'play' && renderPlayTab()}
          {activeTab === 'dashboard' && renderDashboardTab()}
          {activeTab === 'history' && renderHistoryTab()}
          {activeTab === 'wallet' && renderWalletTab()}
        </main>

        {/* ========== BOTTOM TAB BAR ========== */}
        <nav
          className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around px-2 py-2 backdrop-blur-[12px]"
          style={{
            background: 'hsl(260 30% 6% / 0.92)',
            borderTop: '1px solid hsl(180 60% 30% / 0.2)',
          }}
        >
          {tabs.map(tab => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex flex-col items-center gap-0.5 py-1 px-3 rounded transition-all duration-200 relative"
                style={{ color: isActive ? 'hsl(180 100% 50%)' : 'hsl(180 50% 45%)' }}
              >
                {tab.icon}
                <span className="text-xs font-semibold tracking-wider">{tab.label}</span>
                {isActive && (
                  <div
                    className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full"
                    style={{
                      background: 'hsl(180 100% 50%)',
                      boxShadow: '0 0 8px hsl(180 100% 50% / 0.5)',
                    }}
                  />
                )}
              </button>
            )
          })}
        </nav>

        {/* Coin flip animation keyframes */}
        <div
          aria-hidden="true"
          className="hidden"
          dangerouslySetInnerHTML={{
            __html: `<style>@keyframes coinSpin{0%{transform:rotateY(0deg)}100%{transform:rotateY(360deg)}}</style>`,
          }}
        />
      </div>
    </ErrorBoundary>
  )
}
