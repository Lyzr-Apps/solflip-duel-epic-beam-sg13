/**
 * SolFlip Smart Contract Client
 *
 * TypeScript client for interacting with the SolFlip Anchor program on Solana Devnet.
 * Uses direct @solana/web3.js calls with Phantom wallet for transaction signing.
 *
 * DEPLOYMENT INSTRUCTIONS:
 * 1. Install Anchor CLI: https://www.anchor-lang.com/docs/installation
 * 2. cd contracts/solflip
 * 3. anchor build
 * 4. anchor deploy --provider.cluster devnet
 * 5. Copy the deployed program ID and update PROGRAM_ID below
 * 6. Call initializePlatform() once after deployment
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'

// ================================================================
// CONFIGURATION
// ================================================================

/**
 * IMPORTANT: Replace this with your actual deployed program ID after running:
 *   anchor deploy --provider.cluster devnet
 *
 * The placeholder below is NOT a real program ID.
 */
const PROGRAM_ID = new PublicKey(
  'F1ipXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
)

const DEVNET_RPC = 'https://api.devnet.solana.com'

// ================================================================
// PDA DERIVATION
// ================================================================

/**
 * Derive the Platform PDA address.
 * Seeds: ["platform"]
 */
export function getPlatformPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('platform')],
    PROGRAM_ID
  )
}

/**
 * Derive a player's Escrow PDA address.
 * Seeds: ["escrow", player_pubkey]
 */
export function getEscrowPDA(player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), player.toBuffer()],
    PROGRAM_ID
  )
}

/**
 * Derive a Match PDA address.
 * Seeds: ["match", player_a_pubkey, timestamp_le_bytes]
 */
export function getMatchPDA(
  playerA: PublicKey,
  timestamp: number
): [PublicKey, number] {
  const timestampBuffer = Buffer.alloc(8)
  timestampBuffer.writeBigInt64LE(BigInt(timestamp))
  return PublicKey.findProgramAddressSync(
    [Buffer.from('match'), playerA.toBuffer(), timestampBuffer],
    PROGRAM_ID
  )
}

// ================================================================
// COMMIT-REVEAL CRYPTOGRAPHY
// ================================================================

/**
 * Generate a cryptographically secure 32-byte nonce.
 */
export function generateNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

/**
 * Create a commit hash: SHA-256(choice_byte || nonce_bytes)
 * choice: 0 = Heads, 1 = Tails
 */
export async function createCommitHash(
  choice: 0 | 1,
  nonce: Uint8Array
): Promise<Uint8Array> {
  const preimage = new Uint8Array(33)
  preimage[0] = choice
  preimage.set(nonce, 1)
  const hashBuffer = await crypto.subtle.digest('SHA-256', preimage)
  return new Uint8Array(hashBuffer)
}

/**
 * Verify a commit hash locally (for UI display).
 */
export async function verifyCommitHash(
  choice: 0 | 1,
  nonce: Uint8Array,
  expectedHash: Uint8Array
): Promise<boolean> {
  const computed = await createCommitHash(choice, nonce)
  return computed.every((byte, i) => byte === expectedHash[i])
}

// ================================================================
// ANCHOR INSTRUCTION DISCRIMINATORS
// ================================================================
// Anchor uses SHA-256("global:<instruction_name>")[0..8] as discriminator.
// Pre-computed for each instruction.

async function getDiscriminator(name: string): Promise<Buffer> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`global:${name}`)
  )
  return Buffer.from(new Uint8Array(hash).slice(0, 8))
}

// ================================================================
// INSTRUCTION BUILDERS
// ================================================================

/**
 * Build the deposit instruction.
 * Transfers SOL from player wallet to their escrow PDA.
 */
export async function buildDepositInstruction(
  player: PublicKey,
  amountLamports: bigint
): Promise<TransactionInstruction> {
  const [escrowPDA] = getEscrowPDA(player)
  const discriminator = await getDiscriminator('deposit')

  const data = Buffer.alloc(8 + 8)
  discriminator.copy(data, 0)
  data.writeBigUInt64LE(amountLamports, 8)

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

/**
 * Build the withdraw instruction.
 * Transfers SOL from escrow PDA back to player wallet.
 */
export async function buildWithdrawInstruction(
  player: PublicKey,
  amountLamports: bigint
): Promise<TransactionInstruction> {
  const [escrowPDA] = getEscrowPDA(player)
  const discriminator = await getDiscriminator('withdraw')

  const data = Buffer.alloc(8 + 8)
  discriminator.copy(data, 0)
  data.writeBigUInt64LE(amountLamports, 8)

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

/**
 * Build the createMatch instruction.
 * Player A creates a match with a wager and commit hash.
 */
export async function buildCreateMatchInstruction(
  player: PublicKey,
  wagerLamports: bigint,
  commitHash: Uint8Array,
  timestamp: number
): Promise<TransactionInstruction> {
  const [escrowPDA] = getEscrowPDA(player)
  const [matchPDA] = getMatchPDA(player, timestamp)
  const discriminator = await getDiscriminator('create_match')

  // Data: discriminator(8) + wager(8) + commit_hash(32) = 48
  const data = Buffer.alloc(8 + 8 + 32)
  discriminator.copy(data, 0)
  data.writeBigUInt64LE(wagerLamports, 8)
  Buffer.from(commitHash).copy(data, 16)

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPDA, isSigner: false, isWritable: true },
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

/**
 * Build the joinMatch instruction.
 * Player B joins an existing match.
 */
export async function buildJoinMatchInstruction(
  player: PublicKey,
  matchPDA: PublicKey
): Promise<TransactionInstruction> {
  const [escrowPDA] = getEscrowPDA(player)
  const discriminator = await getDiscriminator('join_match')

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPDA, isSigner: false, isWritable: true },
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  })
}

/**
 * Build the reveal instruction.
 * Player A reveals their choice and nonce to determine the winner.
 */
export async function buildRevealInstruction(
  playerA: PublicKey,
  playerB: PublicKey,
  matchPDA: PublicKey,
  choice: 0 | 1,
  nonce: Uint8Array
): Promise<TransactionInstruction> {
  const [escrowA] = getEscrowPDA(playerA)
  const [escrowB] = getEscrowPDA(playerB)
  const [platformPDA] = getPlatformPDA()
  const discriminator = await getDiscriminator('reveal')

  // Fetch platform to get treasury address
  const connection = new Connection(DEVNET_RPC)
  const platformAccount = await connection.getAccountInfo(platformPDA)

  // Treasury is at offset 8 (discriminator) + 32 (authority) = 40, and is 32 bytes
  let treasury: PublicKey
  if (platformAccount?.data) {
    treasury = new PublicKey(platformAccount.data.slice(40, 72))
  } else {
    throw new Error('Platform account not found. Deploy and initialize the contract first.')
  }

  // Data: discriminator(8) + choice(1) + nonce(32) = 41
  const data = Buffer.alloc(8 + 1 + 32)
  discriminator.copy(data, 0)
  data.writeUInt8(choice, 8)
  Buffer.from(nonce).copy(data, 9)

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPDA, isSigner: false, isWritable: true },
      { pubkey: escrowA, isSigner: false, isWritable: true },
      { pubkey: escrowB, isSigner: false, isWritable: true },
      { pubkey: platformPDA, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: playerA, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

/**
 * Build the claimTimeout instruction.
 * Player B claims the pot if Player A fails to reveal within 30 seconds.
 */
export async function buildClaimTimeoutInstruction(
  playerA: PublicKey,
  playerB: PublicKey,
  matchPDA: PublicKey
): Promise<TransactionInstruction> {
  const [escrowA] = getEscrowPDA(playerA)
  const [escrowB] = getEscrowPDA(playerB)
  const discriminator = await getDiscriminator('claim_timeout')

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPDA, isSigner: false, isWritable: true },
      { pubkey: escrowA, isSigner: false, isWritable: true },
      { pubkey: escrowB, isSigner: false, isWritable: true },
      { pubkey: playerB, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  })
}

/**
 * Build the cancelMatch instruction.
 * Player A cancels before an opponent joins.
 */
export async function buildCancelMatchInstruction(
  player: PublicKey,
  matchPDA: PublicKey
): Promise<TransactionInstruction> {
  const [escrowPDA] = getEscrowPDA(player)
  const discriminator = await getDiscriminator('cancel_match')

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: matchPDA, isSigner: false, isWritable: true },
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  })
}

// ================================================================
// ACCOUNT FETCHERS
// ================================================================

export interface EscrowAccount {
  owner: string
  balance: number // in SOL
  balanceLamports: bigint
  locked: boolean
}

export interface MatchAccountData {
  playerA: string
  playerB: string
  wager: number // in SOL
  wagerLamports: bigint
  commitHash: Uint8Array
  state: 'WaitingForOpponent' | 'CommitPhase' | 'Completed' | 'Cancelled'
  createdAt: number
  revealDeadline: number
  choiceA: number
  nonceA: Uint8Array
  result: 'Pending' | 'PlayerAWins' | 'PlayerBWins' | 'PlayerBWinsByForfeit'
}

export interface PlatformData {
  authority: string
  treasury: string
  totalMatches: number
  totalVolumeLamports: bigint
  totalFeesCollected: bigint
}

/**
 * Fetch a player's escrow account data.
 */
export async function fetchEscrowAccount(
  player: PublicKey
): Promise<EscrowAccount | null> {
  const connection = new Connection(DEVNET_RPC)
  const [escrowPDA] = getEscrowPDA(player)

  const accountInfo = await connection.getAccountInfo(escrowPDA)
  if (!accountInfo) return null

  const data = accountInfo.data
  // Layout: discriminator(8) + owner(32) + balance(8) + locked(1) + bump(1)
  const owner = new PublicKey(data.slice(8, 40)).toString()
  const balanceLamports = data.readBigUInt64LE(40)
  const locked = data[48] === 1

  return {
    owner,
    balance: Number(balanceLamports) / LAMPORTS_PER_SOL,
    balanceLamports,
    locked,
  }
}

/**
 * Fetch match account data.
 */
export async function fetchMatchAccount(
  matchPDA: PublicKey
): Promise<MatchAccountData | null> {
  const connection = new Connection(DEVNET_RPC)
  const accountInfo = await connection.getAccountInfo(matchPDA)
  if (!accountInfo) return null

  const data = accountInfo.data
  // Layout: disc(8) + playerA(32) + playerB(32) + wager(8) + commitHash(32) +
  //         state(1) + createdAt(8) + revealDeadline(8) + choiceA(1) + nonceA(32) + result(1) + bump(1)

  const playerA = new PublicKey(data.slice(8, 40)).toString()
  const playerB = new PublicKey(data.slice(40, 72)).toString()
  const wagerLamports = data.readBigUInt64LE(72)
  const commitHash = new Uint8Array(data.slice(80, 112))
  const stateVal = data[112]
  const createdAt = Number(data.readBigInt64LE(113))
  const revealDeadline = Number(data.readBigInt64LE(121))
  const choiceA = data[129]
  const nonceA = new Uint8Array(data.slice(130, 162))
  const resultVal = data[162]

  const stateMap: Record<number, MatchAccountData['state']> = {
    0: 'WaitingForOpponent',
    1: 'CommitPhase',
    2: 'Completed',
    3: 'Cancelled',
  }

  const resultMap: Record<number, MatchAccountData['result']> = {
    0: 'Pending',
    1: 'PlayerAWins',
    2: 'PlayerBWins',
    3: 'PlayerBWinsByForfeit',
  }

  return {
    playerA,
    playerB,
    wager: Number(wagerLamports) / LAMPORTS_PER_SOL,
    wagerLamports,
    commitHash,
    state: stateMap[stateVal] || 'WaitingForOpponent',
    createdAt,
    revealDeadline,
    choiceA,
    nonceA,
    result: resultMap[resultVal] || 'Pending',
  }
}

/**
 * Fetch platform stats.
 */
export async function fetchPlatformStats(): Promise<PlatformData | null> {
  const connection = new Connection(DEVNET_RPC)
  const [platformPDA] = getPlatformPDA()

  const accountInfo = await connection.getAccountInfo(platformPDA)
  if (!accountInfo) return null

  const data = accountInfo.data
  // Layout: disc(8) + authority(32) + treasury(32) + totalMatches(8) + totalVolume(8) + totalFees(8) + bump(1)
  const authority = new PublicKey(data.slice(8, 40)).toString()
  const treasury = new PublicKey(data.slice(40, 72)).toString()
  const totalMatches = Number(data.readBigUInt64LE(72))
  const totalVolumeLamports = data.readBigUInt64LE(80)
  const totalFeesCollected = data.readBigUInt64LE(88)

  return {
    authority,
    treasury,
    totalMatches,
    totalVolumeLamports,
    totalFeesCollected,
  }
}

// ================================================================
// TRANSACTION SENDER (uses Phantom wallet)
// ================================================================

interface PhantomWallet {
  publicKey: { toString: () => string; toBytes: () => Uint8Array } | null
  signTransaction: (tx: Transaction) => Promise<Transaction>
  signAllTransactions: (txs: Transaction[]) => Promise<Transaction[]>
}

/**
 * Send a transaction using Phantom wallet for signing.
 */
export async function sendTransaction(
  wallet: PhantomWallet,
  instruction: TransactionInstruction
): Promise<string> {
  const connection = new Connection(DEVNET_RPC, 'confirmed')

  if (!wallet.publicKey) {
    throw new Error('Wallet not connected')
  }

  const transaction = new Transaction()
  transaction.add(instruction)

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.lastValidBlockHeight = lastValidBlockHeight
  transaction.feePayer = new PublicKey(wallet.publicKey.toString())

  const signedTx = await wallet.signTransaction(transaction)
  const signature = await connection.sendRawTransaction(signedTx.serialize())

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  )

  return signature
}

/**
 * Send multiple instructions in a single transaction.
 */
export async function sendTransactionMulti(
  wallet: PhantomWallet,
  instructions: TransactionInstruction[]
): Promise<string> {
  const connection = new Connection(DEVNET_RPC, 'confirmed')

  if (!wallet.publicKey) {
    throw new Error('Wallet not connected')
  }

  const transaction = new Transaction()
  instructions.forEach((ix) => transaction.add(ix))

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.lastValidBlockHeight = lastValidBlockHeight
  transaction.feePayer = new PublicKey(wallet.publicKey.toString())

  const signedTx = await wallet.signTransaction(transaction)
  const signature = await connection.sendRawTransaction(signedTx.serialize())

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  )

  return signature
}

// ================================================================
// HIGH-LEVEL API (Convenience wrappers)
// ================================================================

/**
 * Deposit SOL into player's escrow.
 */
export async function deposit(
  wallet: PhantomWallet,
  amountSol: number
): Promise<string> {
  const player = new PublicKey(wallet.publicKey!.toString())
  const lamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL))
  const ix = await buildDepositInstruction(player, lamports)
  return sendTransaction(wallet, ix)
}

/**
 * Withdraw SOL from player's escrow.
 */
export async function withdraw(
  wallet: PhantomWallet,
  amountSol: number
): Promise<string> {
  const player = new PublicKey(wallet.publicKey!.toString())
  const lamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL))
  const ix = await buildWithdrawInstruction(player, lamports)
  return sendTransaction(wallet, ix)
}

/**
 * Create a new match. Returns the match PDA, nonce, and commit hash.
 */
export async function createMatch(
  wallet: PhantomWallet,
  wagerSol: number,
  choice: 0 | 1 // 0=Heads, 1=Tails
): Promise<{
  signature: string
  matchPDA: string
  nonce: Uint8Array
  commitHash: Uint8Array
  timestamp: number
}> {
  const player = new PublicKey(wallet.publicKey!.toString())
  const lamports = BigInt(Math.floor(wagerSol * LAMPORTS_PER_SOL))
  const nonce = generateNonce()
  const commitHash = await createCommitHash(choice, nonce)
  const timestamp = Math.floor(Date.now() / 1000)
  const [matchPDA] = getMatchPDA(player, timestamp)

  const ix = await buildCreateMatchInstruction(
    player,
    lamports,
    commitHash,
    timestamp
  )
  const signature = await sendTransaction(wallet, ix)

  return {
    signature,
    matchPDA: matchPDA.toString(),
    nonce,
    commitHash,
    timestamp,
  }
}

/**
 * Join an existing match.
 */
export async function joinMatch(
  wallet: PhantomWallet,
  matchPDAStr: string
): Promise<string> {
  const player = new PublicKey(wallet.publicKey!.toString())
  const matchPDA = new PublicKey(matchPDAStr)
  const ix = await buildJoinMatchInstruction(player, matchPDA)
  return sendTransaction(wallet, ix)
}

/**
 * Reveal choice and nonce to determine winner.
 */
export async function reveal(
  wallet: PhantomWallet,
  matchPDAStr: string,
  playerBStr: string,
  choice: 0 | 1,
  nonce: Uint8Array
): Promise<string> {
  const playerA = new PublicKey(wallet.publicKey!.toString())
  const playerB = new PublicKey(playerBStr)
  const matchPDA = new PublicKey(matchPDAStr)
  const ix = await buildRevealInstruction(
    playerA,
    playerB,
    matchPDA,
    choice,
    nonce
  )
  return sendTransaction(wallet, ix)
}

/**
 * Claim timeout (forfeit win for Player B).
 */
export async function claimTimeout(
  wallet: PhantomWallet,
  matchPDAStr: string,
  playerAStr: string
): Promise<string> {
  const playerA = new PublicKey(playerAStr)
  const playerB = new PublicKey(wallet.publicKey!.toString())
  const matchPDA = new PublicKey(matchPDAStr)
  const ix = await buildClaimTimeoutInstruction(playerA, playerB, matchPDA)
  return sendTransaction(wallet, ix)
}

/**
 * Cancel a match before opponent joins.
 */
export async function cancelMatch(
  wallet: PhantomWallet,
  matchPDAStr: string
): Promise<string> {
  const player = new PublicKey(wallet.publicKey!.toString())
  const matchPDA = new PublicKey(matchPDAStr)
  const ix = await buildCancelMatchInstruction(player, matchPDA)
  return sendTransaction(wallet, ix)
}

// ================================================================
// EXPLORER LINK HELPERS
// ================================================================

export function getExplorerUrl(
  signature: string,
  type: 'tx' | 'address' = 'tx'
): string {
  return `https://explorer.solana.com/${type}/${signature}?cluster=devnet`
}

export function getExplorerAccountUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`
}

// ================================================================
// CONSTANTS EXPORT
// ================================================================

export const SOLFLIP_CONFIG = {
  programId: PROGRAM_ID.toString(),
  devnetRpc: DEVNET_RPC,
  platformFeeBps: 250,
  revealTimeoutSeconds: 30,
  validTiers: [0.1, 0.5, 1, 2], // SOL
  validTiersLamports: [100_000_000, 500_000_000, 1_000_000_000, 2_000_000_000],
} as const
