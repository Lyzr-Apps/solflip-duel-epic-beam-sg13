use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::solana_program::hash::hash;

declare_id!("F1ipXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

/// Platform fee: 2.5% = 250 basis points
const PLATFORM_FEE_BPS: u64 = 250;
const BPS_DENOMINATOR: u64 = 10_000;

/// Maximum reveal timeout in seconds (30s)
const REVEAL_TIMEOUT: i64 = 30;

/// Wager tiers in lamports (0.1, 0.5, 1, 2 SOL)
const VALID_TIERS_LAMPORTS: [u64; 4] = [
    100_000_000,   // 0.1 SOL
    500_000_000,   // 0.5 SOL
    1_000_000_000, // 1.0 SOL
    2_000_000_000, // 2.0 SOL
];

#[program]
pub mod solflip {
    use super::*;

    // ================================================================
    // INITIALIZE PLATFORM
    // ================================================================
    /// Creates the platform state account. Called once by the deployer.
    /// The platform authority collects fees.
    pub fn initialize_platform(ctx: Context<InitializePlatform>) -> Result<()> {
        let platform = &mut ctx.accounts.platform;
        platform.authority = ctx.accounts.authority.key();
        platform.treasury = ctx.accounts.treasury.key();
        platform.total_matches = 0;
        platform.total_volume_lamports = 0;
        platform.total_fees_collected = 0;
        platform.bump = ctx.bumps.platform;
        msg!("Platform initialized. Authority: {}", platform.authority);
        Ok(())
    }

    // ================================================================
    // DEPOSIT TO ESCROW
    // ================================================================
    /// Player deposits SOL into their personal escrow PDA.
    /// Transfers lamports from player wallet to escrow PDA via CPI.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, SolflipError::InvalidAmount);

        let escrow = &mut ctx.accounts.escrow;
        let player = &ctx.accounts.player;

        // Initialize escrow if first deposit
        if escrow.owner == Pubkey::default() {
            escrow.owner = player.key();
            escrow.bump = ctx.bumps.escrow;
        }

        require!(escrow.owner == player.key(), SolflipError::Unauthorized);

        // Transfer SOL from player to escrow PDA
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: player.to_account_info(),
                    to: escrow.to_account_info(),
                },
            ),
            amount,
        )?;

        escrow.balance = escrow
            .balance
            .checked_add(amount)
            .ok_or(SolflipError::Overflow)?;

        msg!(
            "Deposited {} lamports. New escrow balance: {}",
            amount,
            escrow.balance
        );

        emit!(DepositEvent {
            player: player.key(),
            amount,
            new_balance: escrow.balance,
        });

        Ok(())
    }

    // ================================================================
    // WITHDRAW FROM ESCROW
    // ================================================================
    /// Player withdraws SOL from their escrow PDA back to wallet.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let player = &ctx.accounts.player;

        require!(escrow.owner == player.key(), SolflipError::Unauthorized);
        require!(amount > 0, SolflipError::InvalidAmount);
        require!(amount <= escrow.balance, SolflipError::InsufficientFunds);
        require!(!escrow.locked, SolflipError::FundsLocked);

        escrow.balance = escrow
            .balance
            .checked_sub(amount)
            .ok_or(SolflipError::Underflow)?;

        // Transfer SOL from escrow PDA to player
        // For PDA transfers, we need to use the escrow account's lamports directly
        **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **player.to_account_info().try_borrow_mut_lamports()? += amount;

        msg!(
            "Withdrew {} lamports. New escrow balance: {}",
            amount,
            escrow.balance
        );

        emit!(WithdrawEvent {
            player: player.key(),
            amount,
            new_balance: escrow.balance,
        });

        Ok(())
    }

    // ================================================================
    // CREATE MATCH (JOIN QUEUE / MATCHMAKING)
    // ================================================================
    /// Player A creates a match at a specific wager tier.
    /// Their wager is locked from escrow. They wait for Player B.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        wager_lamports: u64,
        commit_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.player_escrow;
        let match_account = &mut ctx.accounts.match_account;
        let player = &ctx.accounts.player;

        // Validate wager tier
        require!(
            VALID_TIERS_LAMPORTS.contains(&wager_lamports),
            SolflipError::InvalidTier
        );

        require!(escrow.owner == player.key(), SolflipError::Unauthorized);
        require!(
            escrow.balance >= wager_lamports,
            SolflipError::InsufficientFunds
        );
        require!(!escrow.locked, SolflipError::FundsLocked);

        // Lock wager from escrow
        escrow.balance = escrow
            .balance
            .checked_sub(wager_lamports)
            .ok_or(SolflipError::Underflow)?;
        escrow.locked = true;

        // Initialize match
        match_account.player_a = player.key();
        match_account.player_b = Pubkey::default();
        match_account.wager = wager_lamports;
        match_account.commit_hash = commit_hash;
        match_account.state = MatchState::WaitingForOpponent;
        match_account.created_at = Clock::get()?.unix_timestamp;
        match_account.reveal_deadline = 0;
        match_account.choice_a = 0;
        match_account.nonce_a = [0u8; 32];
        match_account.result = MatchResult::Pending;
        match_account.bump = ctx.bumps.match_account;

        msg!(
            "Match created. Player A: {}, Wager: {} lamports, Commit: {:?}",
            player.key(),
            wager_lamports,
            &commit_hash[..8]
        );

        emit!(MatchCreatedEvent {
            match_id: match_account.key(),
            player_a: player.key(),
            wager: wager_lamports,
        });

        Ok(())
    }

    // ================================================================
    // JOIN MATCH (Player B)
    // ================================================================
    /// Player B joins an existing match at the same wager tier.
    /// Their wager is locked from escrow. The match moves to commit phase.
    pub fn join_match(ctx: Context<JoinMatch>) -> Result<()> {
        let escrow = &mut ctx.accounts.player_escrow;
        let match_account = &mut ctx.accounts.match_account;
        let player = &ctx.accounts.player;

        require!(
            match_account.state == MatchState::WaitingForOpponent,
            SolflipError::InvalidMatchState
        );
        require!(
            match_account.player_a != player.key(),
            SolflipError::CannotPlaySelf
        );

        require!(escrow.owner == player.key(), SolflipError::Unauthorized);
        require!(
            escrow.balance >= match_account.wager,
            SolflipError::InsufficientFunds
        );
        require!(!escrow.locked, SolflipError::FundsLocked);

        // Lock wager from Player B's escrow
        escrow.balance = escrow
            .balance
            .checked_sub(match_account.wager)
            .ok_or(SolflipError::Underflow)?;
        escrow.locked = true;

        // Update match
        match_account.player_b = player.key();
        match_account.state = MatchState::CommitPhase;
        // Player A has 30 seconds to reveal
        match_account.reveal_deadline = Clock::get()?
            .unix_timestamp
            .checked_add(REVEAL_TIMEOUT)
            .ok_or(SolflipError::Overflow)?;

        msg!(
            "Player B joined. Match: {}, Player B: {}",
            match_account.key(),
            player.key()
        );

        emit!(MatchJoinedEvent {
            match_id: match_account.key(),
            player_a: match_account.player_a,
            player_b: player.key(),
            wager: match_account.wager,
        });

        Ok(())
    }

    // ================================================================
    // REVEAL (Player A reveals choice + nonce)
    // ================================================================
    /// Player A reveals their choice and nonce. The contract verifies
    /// SHA256(choice || nonce) == commit_hash. Then determines winner.
    ///
    /// choice: 0 = Heads, 1 = Tails
    pub fn reveal(ctx: Context<Reveal>, choice: u8, nonce: [u8; 32]) -> Result<()> {
        let match_account = &mut ctx.accounts.match_account;
        let player = &ctx.accounts.player;
        let escrow_a = &mut ctx.accounts.escrow_a;
        let escrow_b = &mut ctx.accounts.escrow_b;
        let platform = &mut ctx.accounts.platform;
        let treasury = &ctx.accounts.treasury;

        require!(
            match_account.state == MatchState::CommitPhase,
            SolflipError::InvalidMatchState
        );
        require!(
            match_account.player_a == player.key(),
            SolflipError::Unauthorized
        );
        require!(choice <= 1, SolflipError::InvalidChoice);

        // Verify commit hash: SHA256(choice_byte || nonce_bytes)
        let mut preimage = Vec::with_capacity(33);
        preimage.push(choice);
        preimage.extend_from_slice(&nonce);
        let computed_hash = hash(&preimage);

        require!(
            computed_hash.to_bytes() == match_account.commit_hash,
            SolflipError::CommitHashMismatch
        );

        match_account.choice_a = choice;
        match_account.nonce_a = nonce;

        // Determine winner using on-chain randomness from slot hashes
        // For devnet demo: XOR the nonce with recent slot hash for fairness
        let clock = Clock::get()?;
        let slot_bytes = clock.slot.to_le_bytes();
        let mut seed_data = Vec::with_capacity(40);
        seed_data.extend_from_slice(&nonce);
        seed_data.extend_from_slice(&slot_bytes);
        let result_hash = hash(&seed_data);

        // Use the first byte of result hash to determine coin flip
        // Even = Heads (0), Odd = Tails (1)
        let coin_result: u8 = result_hash.to_bytes()[0] % 2;

        let player_a_wins = choice == coin_result;

        // Calculate payout and fee
        let total_pot = match_account
            .wager
            .checked_mul(2)
            .ok_or(SolflipError::Overflow)?;
        let fee = total_pot
            .checked_mul(PLATFORM_FEE_BPS)
            .ok_or(SolflipError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(SolflipError::Overflow)?;
        let payout = total_pot.checked_sub(fee).ok_or(SolflipError::Underflow)?;

        if player_a_wins {
            match_account.result = MatchResult::PlayerAWins;

            // Credit Player A's escrow
            escrow_a.balance = escrow_a
                .balance
                .checked_add(payout)
                .ok_or(SolflipError::Overflow)?;

            msg!("Player A wins! Payout: {} lamports", payout);
        } else {
            match_account.result = MatchResult::PlayerBWins;

            // Credit Player B's escrow
            escrow_b.balance = escrow_b
                .balance
                .checked_add(payout)
                .ok_or(SolflipError::Overflow)?;

            msg!("Player B wins! Payout: {} lamports", payout);
        }

        // Transfer fee to treasury
        // The fee comes from the match account's lamports (which held both wagers)
        **match_account.to_account_info().try_borrow_mut_lamports()? -= fee;
        **treasury.to_account_info().try_borrow_mut_lamports()? += fee;

        // Unlock both escrows
        escrow_a.locked = false;
        escrow_b.locked = false;

        // Update match state
        match_account.state = MatchState::Completed;

        // Update platform stats
        platform.total_matches = platform
            .total_matches
            .checked_add(1)
            .ok_or(SolflipError::Overflow)?;
        platform.total_volume_lamports = platform
            .total_volume_lamports
            .checked_add(total_pot)
            .ok_or(SolflipError::Overflow)?;
        platform.total_fees_collected = platform
            .total_fees_collected
            .checked_add(fee)
            .ok_or(SolflipError::Overflow)?;

        emit!(MatchCompletedEvent {
            match_id: match_account.key(),
            player_a: match_account.player_a,
            player_b: match_account.player_b,
            winner: if player_a_wins {
                match_account.player_a
            } else {
                match_account.player_b
            },
            wager: match_account.wager,
            payout,
            fee,
            coin_result,
            choice_a: choice,
            commit_hash: match_account.commit_hash,
            nonce,
        });

        Ok(())
    }

    // ================================================================
    // CLAIM TIMEOUT (Player B claims if Player A doesn't reveal)
    // ================================================================
    /// If Player A fails to reveal within 30 seconds, Player B can
    /// claim the entire pot (auto-forfeit for Player A).
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let match_account = &mut ctx.accounts.match_account;
        let player = &ctx.accounts.player;
        let escrow_a = &mut ctx.accounts.escrow_a;
        let escrow_b = &mut ctx.accounts.escrow_b;

        require!(
            match_account.state == MatchState::CommitPhase,
            SolflipError::InvalidMatchState
        );
        require!(
            match_account.player_b == player.key(),
            SolflipError::Unauthorized
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp > match_account.reveal_deadline,
            SolflipError::RevealNotTimedOut
        );

        // Player A forfeited - Player B gets full pot (no fee on forfeit)
        let total_pot = match_account
            .wager
            .checked_mul(2)
            .ok_or(SolflipError::Overflow)?;

        escrow_b.balance = escrow_b
            .balance
            .checked_add(total_pot)
            .ok_or(SolflipError::Overflow)?;

        // Unlock both escrows
        escrow_a.locked = false;
        escrow_b.locked = false;

        match_account.state = MatchState::Completed;
        match_account.result = MatchResult::PlayerBWinsByForfeit;

        msg!(
            "Player A forfeited (timeout). Player B wins {} lamports",
            total_pot
        );

        emit!(ForfeitEvent {
            match_id: match_account.key(),
            forfeiter: match_account.player_a,
            winner: match_account.player_b,
            amount: total_pot,
        });

        Ok(())
    }

    // ================================================================
    // CANCEL MATCH (Player A cancels before opponent joins)
    // ================================================================
    /// Player A can cancel a match if no opponent has joined yet.
    /// Refunds their wager back to escrow.
    pub fn cancel_match(ctx: Context<CancelMatch>) -> Result<()> {
        let match_account = &mut ctx.accounts.match_account;
        let escrow = &mut ctx.accounts.player_escrow;
        let player = &ctx.accounts.player;

        require!(
            match_account.state == MatchState::WaitingForOpponent,
            SolflipError::InvalidMatchState
        );
        require!(
            match_account.player_a == player.key(),
            SolflipError::Unauthorized
        );

        // Refund wager to Player A
        escrow.balance = escrow
            .balance
            .checked_add(match_account.wager)
            .ok_or(SolflipError::Overflow)?;
        escrow.locked = false;

        match_account.state = MatchState::Cancelled;

        msg!(
            "Match cancelled. Refunded {} lamports to Player A",
            match_account.wager
        );

        emit!(MatchCancelledEvent {
            match_id: match_account.key(),
            player: player.key(),
            refund: match_account.wager,
        });

        Ok(())
    }

    // ================================================================
    // VIEW: Get player escrow balance
    // ================================================================
    pub fn get_escrow_balance(ctx: Context<GetEscrowBalance>) -> Result<u64> {
        Ok(ctx.accounts.escrow.balance)
    }
}

// ================================================================
// ACCOUNT STRUCTS
// ================================================================

/// Platform-wide state. Singleton PDA.
#[account]
#[derive(Default)]
pub struct Platform {
    /// Platform admin who can update settings
    pub authority: Pubkey,       // 32
    /// Treasury wallet for fee collection
    pub treasury: Pubkey,        // 32
    /// Total number of completed matches
    pub total_matches: u64,      // 8
    /// Total SOL volume (in lamports)
    pub total_volume_lamports: u64, // 8
    /// Total fees collected (in lamports)
    pub total_fees_collected: u64,  // 8
    /// PDA bump
    pub bump: u8,                // 1
}
// Size: 8 (discriminator) + 32 + 32 + 8 + 8 + 8 + 1 = 97

/// Per-player escrow account. PDA seeded by ["escrow", player_pubkey].
#[account]
#[derive(Default)]
pub struct Escrow {
    /// Player who owns this escrow
    pub owner: Pubkey,    // 32
    /// Current balance in lamports
    pub balance: u64,     // 8
    /// Whether funds are locked in an active match
    pub locked: bool,     // 1
    /// PDA bump
    pub bump: u8,         // 1
}
// Size: 8 + 32 + 8 + 1 + 1 = 50

/// A single coin flip match between two players.
/// PDA seeded by ["match", player_a, timestamp].
#[account]
#[derive(Default)]
pub struct MatchAccount {
    /// Player A (match creator, commits first)
    pub player_a: Pubkey,        // 32
    /// Player B (match joiner)
    pub player_b: Pubkey,        // 32
    /// Wager amount per player in lamports
    pub wager: u64,              // 8
    /// SHA256 commit hash from Player A: hash(choice || nonce)
    pub commit_hash: [u8; 32],   // 32
    /// Current match state
    pub state: MatchState,       // 1
    /// Unix timestamp when match was created
    pub created_at: i64,         // 8
    /// Deadline for Player A to reveal (unix timestamp)
    pub reveal_deadline: i64,    // 8
    /// Player A's revealed choice (0=Heads, 1=Tails)
    pub choice_a: u8,            // 1
    /// Player A's revealed nonce
    pub nonce_a: [u8; 32],       // 32
    /// Match result
    pub result: MatchResult,     // 1
    /// PDA bump
    pub bump: u8,                // 1
}
// Size: 8 + 32 + 32 + 8 + 32 + 1 + 8 + 8 + 1 + 32 + 1 + 1 = 164

// ================================================================
// ENUMS
// ================================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum MatchState {
    #[default]
    WaitingForOpponent,
    CommitPhase,
    Completed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum MatchResult {
    #[default]
    Pending,
    PlayerAWins,
    PlayerBWins,
    PlayerBWinsByForfeit,
}

// ================================================================
// CONTEXT STRUCTS (Instruction Accounts)
// ================================================================

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 97,
        seeds = [b"platform"],
        bump
    )]
    pub platform: Account<'info, Platform>,

    /// CHECK: Treasury wallet to receive fees
    #[account(mut)]
    pub treasury: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + 50,
        seeds = [b"escrow", player.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"escrow", player.key().as_ref()],
        bump = escrow.bump,
        has_one = owner @ SolflipError::Unauthorized,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// Use a unique match seed: ["match", player_a, match_id_bytes]
#[derive(Accounts)]
#[instruction(wager_lamports: u64, commit_hash: [u8; 32])]
pub struct CreateMatch<'info> {
    #[account(
        init,
        payer = player,
        space = 8 + 164,
        seeds = [b"match", player.key().as_ref(), &Clock::get()?.unix_timestamp.to_le_bytes()],
        bump
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        mut,
        seeds = [b"escrow", player.key().as_ref()],
        bump = player_escrow.bump,
    )]
    pub player_escrow: Account<'info, Escrow>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(
        mut,
        constraint = match_account.state == MatchState::WaitingForOpponent @ SolflipError::InvalidMatchState,
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        mut,
        seeds = [b"escrow", player.key().as_ref()],
        bump = player_escrow.bump,
    )]
    pub player_escrow: Account<'info, Escrow>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reveal<'info> {
    #[account(
        mut,
        constraint = match_account.state == MatchState::CommitPhase @ SolflipError::InvalidMatchState,
        constraint = match_account.player_a == player.key() @ SolflipError::Unauthorized,
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        mut,
        seeds = [b"escrow", match_account.player_a.as_ref()],
        bump = escrow_a.bump,
    )]
    pub escrow_a: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"escrow", match_account.player_b.as_ref()],
        bump = escrow_b.bump,
    )]
    pub escrow_b: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"platform"],
        bump = platform.bump,
    )]
    pub platform: Account<'info, Platform>,

    /// CHECK: Treasury wallet for fee collection
    #[account(
        mut,
        constraint = treasury.key() == platform.treasury @ SolflipError::InvalidTreasury,
    )]
    pub treasury: AccountInfo<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(
        mut,
        constraint = match_account.state == MatchState::CommitPhase @ SolflipError::InvalidMatchState,
        constraint = match_account.player_b == player.key() @ SolflipError::Unauthorized,
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        mut,
        seeds = [b"escrow", match_account.player_a.as_ref()],
        bump = escrow_a.bump,
    )]
    pub escrow_a: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"escrow", match_account.player_b.as_ref()],
        bump = escrow_b.bump,
    )]
    pub escrow_b: Account<'info, Escrow>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelMatch<'info> {
    #[account(
        mut,
        constraint = match_account.state == MatchState::WaitingForOpponent @ SolflipError::InvalidMatchState,
        constraint = match_account.player_a == player.key() @ SolflipError::Unauthorized,
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        mut,
        seeds = [b"escrow", player.key().as_ref()],
        bump = player_escrow.bump,
    )]
    pub player_escrow: Account<'info, Escrow>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GetEscrowBalance<'info> {
    #[account(
        seeds = [b"escrow", player.key().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    pub player: Signer<'info>,
}

// ================================================================
// ERRORS
// ================================================================

#[error_code]
pub enum SolflipError {
    #[msg("Invalid amount")]
    InvalidAmount,

    #[msg("Insufficient funds in escrow")]
    InsufficientFunds,

    #[msg("Funds are locked in an active match")]
    FundsLocked,

    #[msg("Unauthorized: you don't own this account")]
    Unauthorized,

    #[msg("Invalid wager tier")]
    InvalidTier,

    #[msg("Invalid match state for this operation")]
    InvalidMatchState,

    #[msg("Cannot play against yourself")]
    CannotPlaySelf,

    #[msg("Invalid choice: must be 0 (Heads) or 1 (Tails)")]
    InvalidChoice,

    #[msg("Commit hash does not match reveal")]
    CommitHashMismatch,

    #[msg("Reveal timeout has not expired yet")]
    RevealNotTimedOut,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Arithmetic underflow")]
    Underflow,

    #[msg("Invalid treasury account")]
    InvalidTreasury,
}

// ================================================================
// EVENTS
// ================================================================

#[event]
pub struct DepositEvent {
    pub player: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct WithdrawEvent {
    pub player: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct MatchCreatedEvent {
    pub match_id: Pubkey,
    pub player_a: Pubkey,
    pub wager: u64,
}

#[event]
pub struct MatchJoinedEvent {
    pub match_id: Pubkey,
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub wager: u64,
}

#[event]
pub struct MatchCompletedEvent {
    pub match_id: Pubkey,
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub winner: Pubkey,
    pub wager: u64,
    pub payout: u64,
    pub fee: u64,
    pub coin_result: u8,
    pub choice_a: u8,
    pub commit_hash: [u8; 32],
    pub nonce: [u8; 32],
}

#[event]
pub struct ForfeitEvent {
    pub match_id: Pubkey,
    pub forfeiter: Pubkey,
    pub winner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MatchCancelledEvent {
    pub match_id: Pubkey,
    pub player: Pubkey,
    pub refund: u64,
}
