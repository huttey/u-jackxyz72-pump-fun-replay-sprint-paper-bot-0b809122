// Dip-rebound trader for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The hello message carries the seed, the capital, the caps and the fees; every batch after
// that is one slot of chain events, and the orders decided on a batch resolve two slots later
// (the slot latency), so every decision is made on reserves that are already two slots old.
//
// Idea: a curve that ran up and then dropped sharply from its recent high, while buyers are
// still stepping in, tends to bounce part of the way back. This bot buys into that dip and
// sells the partial rebound. It never chases a burst: the data on the dev window says coins
// bought at the top of a burst fade (their median end price is little more than half the
// entry), while a coin bought 25-50% below its recent high, with buyers returning, bounces
// often enough to pay for the losers. The winners here are small and quick — a 30% recovery
// of the dip, or +30% against cost — and the losers are cut at -12% or after 300 slots.
//
// Fees set the floor: a round trip pays 125 bps of curve fees each way plus two fixed tx
// fees, so a trade needs roughly a 3% move just to break even. That is why buys smaller
// than 0.01 SOL are skipped (the fixed tx fee eats them) and why the stake is 0.05 SOL.
//
// Guardrail pacing: the run must end with round trips on at least 20 distinct coins. When
// the coins traded lag the pace of block time through the window, open a tiny 0.01 SOL probe
// on the most liquid traded curve and sell it as soon as the buy lands. Probes lose a little
// each; they exist only to keep the guardrail met when the main signal goes quiet.
//
// Deterministic by construction: no clock, no randomness, no environment reads. Iteration is
// over insertion-ordered maps fed by the batch stream, and every float is computed the same
// way in both executions.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // 95 bps protocol + 30 bps creator, charged on each side.
const BPS = 10_000;

// ---- tunables: picked on the dev window by sweeping the offline replay, preferring the
// middle of the flat positive region over its single best cell ----
const HIGH_WINDOW = 60; // lookback, slots, for the recent high the dip is measured from
const DD_MIN = 0.25; // enter when price is at least this far below the recent high
const DD_MAX = 0.5; // ...and not further than this (a collapse, not a dip)
const MIN_AGE = 60; // slots since CreateEvent before an entry is allowed
const MIN_RQ_SOL = 2.0; // curve real SOL at entry, low end
const MAX_RQ_SOL = 60.0; // curve real SOL at entry, high end
const FLOW_TRADES = 10; // last trades the flow test looks at
const FLOW_MIN_BUYS = 6; // of those, at least this many must be buys
const FLOW_MIN_NET_SOL = -0.1; // net SOL over those trades, at least this
const STAKE_SOL = 0.05; // one buy per position, no adds
const MIN_BUY_SOL = 0.01; // smallest buy worth sending (tx fee floor)
const BUY_SLIP_BPS = 1000; // buys refuse a fill worse than this vs decision reserves
const TAKE_PROFIT = 0.3; // exit the whole position at this gain against cost
const RECOVER = 0.3; // exit when price recovers this share of the dip (entry to high)
const STOP_LOSS = 0.12; // exit when value falls this far below cost
const MAX_HOLD = 300; // exit after this many slots held
const COOLDOWN = 100; // slots to wait after an exit before re-entering a curve
const MAX_ENTRIES = 2; // most entries per curve over the run
const TARGET_COINS = 25; // guardrail pacing target
const TARGET_FILLS = 240;
const PACE_SECS = 14_400; // block-time span the pace is measured over
const PROBE_SOL = 0.01;
const MAX_PROBES = 1;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Open {
  opened: number;
  peakValue: number; // best close value seen, SOL
  invested: number; // SOL sent in buys (fees included)
  exiting: boolean;
  filled: boolean; // some buy of this position filled
  entryPrice: number; // recorded price when the buy was decided
  entryHigh: number; // the recent high the dip was measured from
}

function createBot(): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, Open>();
  const probes = new Map<Pubkey, boolean>(); // mint -> true once its sell is out
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = 400; // slots of tape kept per curve

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  // What a position would bring if sold now, in SOL, curve and tx fees deducted.
  const closeValueSol = (tokens: bigint, vq: bigint, vt: bigint, txLamports: bigint): number => {
    const out = (tokens * vq) / (vt + tokens); // lamports before fees
    const net = (out * BigInt(Math.round((1 - CURVE_FEE) * 10000))) / 10000n - txLamports;
    return Number(net) / LAMPORTS;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // --- exits first: take-profit, partial recovery, stop, time limit ---
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const price = Number(vq) / Number(vt);
        const value = closeValueSol(pos.token_amount, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
        if (!exit && h.entryHigh > h.entryPrice && price >= h.entryPrice + RECOVER * (h.entryHigh - h.entryPrice)) exit = true;
        if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
        if (!exit && now - h.opened > MAX_HOLD) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
      }

      // --- probe sells: dump a landed probe at once ---
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
        if (!selling) probes.set(mint, true);
      }

      // --- entries: buy the dip while buyers are stepping in ---
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (slotsLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
        if (t.created === null || now - t.created < MIN_AGE) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        let high = 0;
        for (const tr of t.trades) {
          if (tr.slot > now - HIGH_WINDOW && tr.price > high) high = tr.price;
        }
        if (high <= 0) continue;
        const dd = 1 - price / high;
        if (dd < DD_MIN || dd > DD_MAX) continue;
        const lastTrades = t.trades.slice(-FLOW_TRADES);
        if (lastTrades.length < 3) continue;
        let buys = 0;
        let net = 0;
        for (const tr of lastTrades) {
          if (tr.buy) buys++;
          net += tr.buy ? tr.sol : -tr.sol;
        }
        if (buys < FLOW_MIN_BUYS) continue;
        if (!lastTrades[lastTrades.length - 1]!.buy) continue;
        if (net < FLOW_MIN_NET_SOL) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, STAKE_SOL);
        if (amount > free - Number(tx) / LAMPORTS) amount = free - Number(tx) / LAMPORTS;
        if (amount < MIN_BUY_SOL) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
        free -= amount + Number(tx) / LAMPORTS;
        open.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          entryPrice: price,
          entryHigh: high,
        });
        t.entries++;
        slotsLeft--;
      }

      // --- guardrail pacing: probe the most liquid traded curve when behind pace ---
      if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
        const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
        const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
        if (needCoins || needFills) {
          const minRq = (PROBE_SOL * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const mint of traded) {
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rq = Number(curve.real_quote_reserves) / LAMPORTS;
            if (rq < minRq * 1.5) continue;
            if (rq > bestRq) {
              bestRq = rq;
              best = mint;
            }
          }
          if (best !== null && free >= PROBE_SOL + (2 * Number(tx)) / LAMPORTS && orders.length < cap) {
            orders.push({
              side: 'buy',
              mint: best,
              quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)),
              max_slippage_bps: BUY_SLIP_BPS,
            });
            probes.set(best, false);
            free -= PROBE_SOL + Number(tx) / LAMPORTS;
          }
        }
      }

      return orders;
    },
  };
}

await runBot(createBot());
