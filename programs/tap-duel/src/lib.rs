//! Tap-Duel Arena — a real-time 1v1 tug-of-war on Solana, powered by MagicBlock Ephemeral Rollups.
//!
//! Lifecycle:
//!   1. `create_duel`  (base layer) — host opens a duel, registers a session key.
//!   2. `join_duel`    (base layer) — challenger joins, registers their session key.
//!   3. `delegate_duel`(base layer) — the Duel PDA is delegated into an Ephemeral Rollup.
//!   4. `tap`          (ER, gasless) — each tap is signed by a player's session key and moves the
//!                                     rope. Many of these fire per second with ~10ms latency and
//!                                     zero fees. This is the real-time core of the demo.
//!   5. `settle`       (ER)         — commit_and_undelegate: final rope + winner is written back to
//!                                     the Solana base layer, then ownership is returned to L1.
//!
//! Session keys: `create_duel`/`join_duel` register a per-player ephemeral pubkey. `tap`/`settle`
//! are signed by that session key instead of the player's wallet, so the mobile app never shows a
//! wallet popup mid-game. (Production apps can swap this lightweight check for MagicBlock's
//! session-keys program; the trust model is the same: a scoped delegated signer.)

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("BmDc7HBxBt5bZLFz6UJ24mdHYr7DQfFw7eSnpo3HamQ6");

/// Max rope units a single tap can move (base tap = 1; VRF boosts raise it, capped here).
const MAX_TAP_POWER: u8 = 5;

#[program]
pub mod tap_duel {
    use super::*;

    /// Host opens a duel. `target` is how far the rope must be pulled to win (e.g. 100).
    /// `host_session` is the ephemeral pubkey the host's app will sign taps with.
    pub fn create_duel(ctx: Context<CreateDuel>, target: i32, host_session: Pubkey) -> Result<()> {
        require!(target > 0 && target <= 10_000, DuelError::InvalidTarget);
        let duel = &mut ctx.accounts.duel;
        duel.host = ctx.accounts.host.key();
        duel.challenger = Pubkey::default();
        duel.host_session = host_session;
        duel.challenger_session = Pubkey::default();
        duel.rope = 0;
        duel.target = target;
        duel.status = DuelStatus::WaitingForChallenger as u8;
        duel.winner = Pubkey::default();
        duel.tap_count = 0;
        duel.bump = ctx.bumps.duel;
        Ok(())
    }

    /// Challenger joins an open duel and registers their session key. Duel becomes Active.
    pub fn join_duel(ctx: Context<JoinDuel>, challenger_session: Pubkey) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        require!(
            duel.status == DuelStatus::WaitingForChallenger as u8,
            DuelError::NotJoinable
        );
        require!(
            ctx.accounts.challenger.key() != duel.host,
            DuelError::CannotDuelYourself
        );
        duel.challenger = ctx.accounts.challenger.key();
        duel.challenger_session = challenger_session;
        duel.status = DuelStatus::Active as u8;
        Ok(())
    }

    /// Delegate the Duel PDA into the Ephemeral Rollup. After this, taps execute on the ER.
    /// Signed by the host (pays the base-layer fee for this one-time delegation tx).
    pub fn delegate_duel(ctx: Context<DelegateDuel>) -> Result<()> {
        let host_key = ctx.accounts.host.key();
        let seeds: &[&[u8]] = &[DUEL_SEED, host_key.as_ref()];
        ctx.accounts.delegate_duel(
            &ctx.accounts.host,
            seeds,
            DelegateConfig {
                // Auto-commit rope state to L1 roughly twice a second so a spectator on the base
                // layer sees live-ish progress even before the final settle.
                commit_frequency_ms: 500,
                validator: None,
            },
        )?;
        Ok(())
    }

    /// A single tap — runs on the Ephemeral Rollup, gasless, signed by a session key.
    /// The host pulls the rope negative; the challenger pulls it positive. First to `target` wins.
    /// `power` is 1 for a normal tap, or up to MAX_TAP_POWER when a VRF boost is applied client-side.
    pub fn tap(ctx: Context<Tap>, power: u8) -> Result<()> {
        let duel = &mut ctx.accounts.duel;
        require!(duel.status == DuelStatus::Active as u8, DuelError::NotActive);

        let signer = ctx.accounts.session_signer.key();
        let pull: i32 = power.clamp(1, MAX_TAP_POWER) as i32;

        if signer == duel.host_session {
            duel.rope -= pull;
        } else if signer == duel.challenger_session {
            duel.rope += pull;
        } else {
            return err!(DuelError::UnauthorizedSession);
        }

        duel.tap_count = duel.tap_count.saturating_add(1);

        if duel.rope <= -duel.target {
            duel.status = DuelStatus::Finished as u8;
            duel.winner = duel.host;
        } else if duel.rope >= duel.target {
            duel.status = DuelStatus::Finished as u8;
            duel.winner = duel.challenger;
        }
        Ok(())
    }

    /// Commit the final state to Solana L1 and undelegate. Callable by either session key
    /// (the app fires this automatically the moment a winner is decided). Gasless on the ER.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let signer = ctx.accounts.session_signer.key();
        require!(
            signer == ctx.accounts.duel.host_session
                || signer == ctx.accounts.duel.challenger_session,
            DuelError::UnauthorizedSession
        );
        commit_and_undelegate_accounts(
            &ctx.accounts.session_signer.to_account_info(),
            vec![&ctx.accounts.duel.to_account_info()],
            &ctx.accounts.magic_context.to_account_info(),
            &ctx.accounts.magic_program.to_account_info(),
            None,
        )?;
        Ok(())
    }
}

pub const DUEL_SEED: &[u8] = b"duel";

#[repr(u8)]
pub enum DuelStatus {
    WaitingForChallenger = 0,
    Active = 1,
    Finished = 2,
}

#[account]
pub struct Duel {
    pub host: Pubkey,
    pub challenger: Pubkey,
    pub host_session: Pubkey,
    pub challenger_session: Pubkey,
    pub winner: Pubkey,
    pub rope: i32,
    pub target: i32,
    pub tap_count: u64,
    pub status: u8,
    pub bump: u8,
}

impl Duel {
    // discriminator + 5 pubkeys + i32 + i32 + u64 + u8 + u8
    pub const SIZE: usize = 8 + (32 * 5) + 4 + 4 + 8 + 1 + 1;
}

#[derive(Accounts)]
pub struct CreateDuel<'info> {
    #[account(mut)]
    pub host: Signer<'info>,
    #[account(
        init,
        payer = host,
        space = Duel::SIZE,
        seeds = [DUEL_SEED, host.key().as_ref()],
        bump
    )]
    pub duel: Account<'info, Duel>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinDuel<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,
    #[account(mut, seeds = [DUEL_SEED, duel.host.as_ref()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
}

/// The `#[delegate]` macro injects buffer_duel / delegation_record_duel / delegation_metadata_duel
/// plus owner_program, delegation_program, system_program, and a `delegate_duel()` helper.
#[delegate]
#[derive(Accounts)]
pub struct DelegateDuel<'info> {
    #[account(mut)]
    pub host: Signer<'info>,
    /// CHECK: delegated PDA; validated by seeds. `del` marks it for delegation.
    #[account(mut, del, seeds = [DUEL_SEED, host.key().as_ref()], bump)]
    pub duel: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Tap<'info> {
    /// The in-app session key. On the ER this is gasless, so it needs no SOL — that is exactly
    /// what removes the per-tap wallet popup on mobile.
    pub session_signer: Signer<'info>,
    #[account(mut, seeds = [DUEL_SEED, duel.host.as_ref()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
}

/// The `#[commit]` macro injects magic_program and magic_context.
#[commit]
#[derive(Accounts)]
pub struct Settle<'info> {
    pub session_signer: Signer<'info>,
    #[account(mut, seeds = [DUEL_SEED, duel.host.as_ref()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
}

#[error_code]
pub enum DuelError {
    #[msg("Target must be between 1 and 10000")]
    InvalidTarget,
    #[msg("Duel is not open for joining")]
    NotJoinable,
    #[msg("You cannot duel yourself")]
    CannotDuelYourself,
    #[msg("Duel is not active")]
    NotActive,
    #[msg("Signer is not a registered session key for this duel")]
    UnauthorizedSession,
}
