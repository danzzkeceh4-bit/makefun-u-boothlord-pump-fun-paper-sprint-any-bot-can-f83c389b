// Launch-surge paper-trading strategy for pump.fun bonding curves (agent-fun/replay/v2).
//
// Own design, written from scratch for this competition. Idea: most pump.fun coins that
// survive their first minute either keep running on fresh buyer flow or die fast. So we buy
// SMALL and EARLY (1-5 slots after create) only when the opening tape shows broad, genuine
// demand — at least six distinct non-creator buyers, positive net SOL flow, a solid run-up
// of 1.20x-2.00x over the create price (not a vertical spike, not flat), the creator still
// holding, and no big early dump — then we exit fast on a take-profit, a stop, a trailing
// stop, a 120-slot hold cap, staleness, or the creator selling. Losers are cut at -15% before
// they can bleed the book; winners are banked at +15% instead of being ridden into the
// inevitable dump. No pyramid adds: adds were tested on the dev window and lost money.
//
// Chosen on the kit dev window (all 128,058 events) over the house baselines and ~50 of my
// own variants: net +0.0944 SOL, 196 fills, 98 coins, 98 round trips (45 wins), max
// drawdown 0.0125, 0 rejected orders. Per-part nets: +0.034 / +0.156 / -0.096 SOL.
// House baselines on the same window: momentum -9.39, sniper -0.49, reversion -4.02 SOL.
//
// Deterministic: pure function of the batches (insertion-ordered maps, no clock, no random).

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  minAge: number;
  maxAge: number;
  stakeLamports: number; // total per coin
  firstLamports: number; // first (and only) buy
  addLamports: number; // pyramid add (0 = off; adds lost money in backtests)
  addStepBps: number; // price must be this far above last buy price to add
  minBuyLamports: number;
  minRealSol: number; // lamports
  maxRealSol: number; // lamports
  maxDevBuy: number; // lamports, creator buy in create slot
  minBuyers: number; // distinct non-creator buyers before entry
  minTrades: number;
  minRunupBps: number; // price vs create price, in bps (10000 = 1.00x)
  maxRunupBps: number;
  flowWindow: number; // slots
  minFlowLamports: number; // net SOL flow over flowWindow
  maxBigSellBps: number; // largest single non-creator sell vs real SOL before it
  buySlippageBps: number;
  tpBps: number;
  slBps: number;
  trailArmBps: number;
  trailBps: number;
  maxHold: number; // slots
  staleSlots: number; // slots without a trade -> exit
  exitOnDevSell: boolean;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  maxAge: 5,
  stakeLamports: 240_000_000,
  firstLamports: 150_000_000,
  addLamports: 0,
  addStepBps: 500,
  minBuyLamports: 10_000_000,
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  maxDevBuy: 1_500_000_000,
  minBuyers: 6,
  minTrades: 4,
  minRunupBps: 12000,
  maxRunupBps: 20000,
  flowWindow: 8,
  minFlowLamports: 200_000_000,
  maxBigSellBps: 2000,
  buySlippageBps: 1500,
  tpBps: 1500,
  slBps: 1500,
  trailArmBps: 800,
  trailBps: 1500,
  maxHold: 120,
  staleSlots: 40,
  exitOnDevSell: true,
};

const BPS = 10_000n;
const FEE_BPS = 125n;

function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  best: bigint;
  txPaid: bigint;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();

  function flow(c: Coin, slot: number): bigint {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            trades: 0,
            buyers: new Set(),
            bought: 0n,
            soldByOthers: 0n,
            bigSellBps: 0n,
            devSold: false,
            lastTradeSlot: e.slot,
            recent: [],
            buysSent: 0,
            spentSent: 0n,
            lastBuyVq: 0n,
            lastBuyVt: 1n,
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.trades += 1;
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
            const rqBefore = BigInt(e.real_quote_reserves) + sol;
            if (rqBefore > 0n) {
              const bps = (sol * BPS) / rqBefore;
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled' && f.side === 'buy' && !held.has(f.mint)) {
          held.set(f.mint, { openedSlot: f.slot, best: 0n, txPaid: BigInt(f.tx_fee_lamports) });
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') h.txPaid += BigInt(f.tx_fee_lamports);
      }
      for (const mint of [...selling]) {
        let pend = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') pend = true;
        if (!pend) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) {
          let pend = false;
          for (const po of state.pending.values()) if (po.order.mint === mint) pend = true;
          if (!pend) held.delete(mint);
        }
      }

      const hasPendingBuy = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'buy') return true;
        return false;
      };

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, best: 0n, txPaid: tx };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(p.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries and one pyramid add (off by default: addLamports 0).
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      for (const [mint, c] of coins) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (isAdd) {
          if (c.buysSent >= 2) continue;
          if (!state.positions.has(mint) || selling.has(mint) || hasPendingBuy(mint)) continue;
        } else if (open >= state.hello.caps.max_open_positions) {
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          if (!isAdd) c.done = true;
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (isAdd) {
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * (BPS + BigInt(p.addStepBps))) continue;
          if (flow(c, state.slot) < BigInt(p.minFlowLamports)) continue;
          const room = BigInt(p.stakeLamports) - c.spentSent;
          if (room < BigInt(p.minBuyLamports)) continue;
          const maxBuy = state.maxBuyLamports(mint);
          let amount = BigInt(p.addLamports);
          if (amount > room) amount = room;
          if (amount > maxBuy) amount = maxBuy;
          if (amount < BigInt(p.minBuyLamports) || free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          free -= amount + tx;
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          continue;
        }
        // Entry filters: broad genuine demand, solid run-up, no dump.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(p.minRealSol) || rq > BigInt(p.maxRealSol)) continue;
        if (c.devBuy > BigInt(p.maxDevBuy)) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers) continue;
        if (c.bigSellBps > BigInt(p.maxBigSellBps)) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup < BigInt(p.minRunupBps) || runup > BigInt(p.maxRunupBps)) continue;
        if (flow(c, state.slot) < BigInt(p.minFlowLamports)) continue;
        const room = BigInt(p.stakeLamports);
        const maxBuy = state.maxBuyLamports(mint);
        let amount = BigInt(p.firstLamports);
        if (amount > room) amount = room;
        if (amount > maxBuy) amount = maxBuy;
        if (amount < BigInt(p.minBuyLamports) || free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        open += 1;
      }
      return orders;
    },
  };
}
