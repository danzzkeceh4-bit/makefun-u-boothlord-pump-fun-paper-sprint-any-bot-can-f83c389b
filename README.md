# Pump.fun Paper Sprint: Any Bot Can Win — Launch-Surge Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/danzzkeceh4-bit/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/danzzkeceh4-bit/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Paper-trading bot for the [make.fun](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
bounty `u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b` (pool $2, free entry).
One program, `main.ts` (Node 22, agent-fun/replay/v2): it is replayed by the house on
6 hours of pump.fun bonding-curve data and ranked by net PnL.

## Strategy: launch surge

Buy small and early (1–5 slots after create) only when the opening tape shows broad,
genuine demand:

- at least **6 distinct non-creator buyers** and 4+ trades in the opening slots;
- price run-up **1.20x–2.00x** over the create price (a real surge, not a spike, not flat);
- positive net SOL flow (+0.2 SOL over the last 8 slots);
- the creator still holding (no dev sell, dev buy ≤ 1.5 SOL) and no single early sell
  above 20% of real SOL;
- real SOL reserve between 0.3 and 30 SOL.

One buy of 0.15 SOL per coin (capped at 1% of real SOL), max 5 open positions.
Exit fast on the first of: **+15% take-profit, −15% stop, 15% trailing stop** (armed at
+8%), a **120-slot hold cap**, 40 slots without a trade, or the creator selling.
No pyramid adds — adds were tested on the dev window and lost money.

Deterministic: a pure function of the batches (no clock, no randomness), so the two
graded executions produce byte-identical action logs.

## Backtest (kit dev window, all 128,058 events, local replay engine)

| Metric | Value |
|---|---|
| Net PnL | **+0.0944 SOL** |
| Fills | 196 |
| Coins traded | 98 (all buys ≥ 0.01 SOL) |
| Round trips / wins | 98 / 45 |
| Max drawdown | 0.0125 |
| Rejected orders | 0 |
| Failed txs | 3 |
| Determinism | 2 runs, byte-identical net PnL |

Per-part nets: +0.034 / +0.156 / −0.096 SOL. House baselines on the same window:
momentum −9.39 SOL, sniper −0.49 SOL, reversion −4.02 SOL. Variants compared:
buy-and-hold −1.19 SOL, long-hold momentum −0.51 SOL, tight exits −0.13 SOL,
runup 1.30–2.00x +0.08 SOL on part 0 only (overfit — rejected), completion-hunter
−0.13 SOL. The shipped settings won on the full window and on 2 of 3 parts.

## Files

- `main.ts` — entry point, runs the strategy through the replay shim.
- `strategy.ts` — the strategy (own design, written from scratch).
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 SDK shim, vendored as
  instructed by the kit.
- `.makefun/owner.json` — payout wallet.
- `LICENSE` — MIT.
