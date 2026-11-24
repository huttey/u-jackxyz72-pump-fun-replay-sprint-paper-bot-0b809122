# Pump.fun Replay Sprint — Paper Bot

![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/huttey/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/huttey/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)

An early-burst sniper for the [make.fun](https://make.fun) Pump.fun Replay Sprint.
It trades 10 SOL of paper money on a replay of recorded pump.fun bonding-curve
activity — nothing is traded for real.

## How it trades

- **Entry:** a coin in its first minute, only when several different wallets are
  buying, net SOL is flowing in, the price is up over a short window and sitting
  near its high, and the curve already holds enough real SOL for a meaningful buy.
  One buy per coin (0.06 SOL at most), one single add if the price steps up.
- **Exits:** stop out at −12% against cost, trail −15% once the position is +8%
  up, take the whole position off at +50%, never hold longer than 400 slots.
- **Guardrails:** tiny 0.01 SOL probes keep the run on pace for the 20-coin
  minimum when the main signal goes quiet; at most 5 open positions.
- **Determinism:** no clock, no randomness, no environment reads — the two
  graded executions produce byte-identical action logs.

## Run it

The grader runs `node /bot/main.ts`. `main.ts` is the whole strategy; the
`vendor/makefun-bot.ts` shim is the kit's own SDK file, vendored byte for byte.
