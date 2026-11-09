# Durable Object transfer test

A rehearsal of the `PrGateAgent` move (ADR 0018) on two throwaway Workers, run by the operator
before `pr-gate-cutover.yml`. The Cloudflare docs do not state whether SQLite data, alarms and object
ids survive a transfer; this test shows it on our account and our wrangler version.

Nothing here touches Custodes Workers or data. The Workers are `custodes-transfer-test-source` and
`custodes-transfer-test-target`, on `workers.dev`.

## Run

From the repository root, with your own wrangler login (`pnpm --filter ./workers/agents exec
wrangler login`), using the repo's pinned wrangler:

```bash
W="pnpm --filter ./workers/agents exec wrangler"
T=../../scripts/do-transfer-test

$W deploy -c $T/source.jsonc
SRC=https://custodes-transfer-test-source.<your-subdomain>.workers.dev
curl "$SRC/set?v=hello&alarmIn=300000"   # value + an alarm 5 minutes out
curl "$SRC/"                             # note "id", "value", "alarm"

$W deploy -c $T/target-expecting.jsonc  # 1. target expects the class
$W deploy -c $T/source-transferred.jsonc # 2. source hands it over (commits; no rollback)
$W deploy -c $T/target-final.jsonc      # 3. target binds it

TGT=https://custodes-transfer-test-target.<your-subdomain>.workers.dev
curl "$TGT/"                             # right after the move
# wait until the alarm time has passed, then:
curl "$TGT/"
```

## Pass criteria

All four must hold, or do not run the real cutover:

1. Every deploy succeeds.
2. On the target, `id` is the same as on the source and `value` is `"hello"` (SQLite data moved).
3. Right after the move, `alarm` on the target is still set (the pending alarm moved).
4. After the alarm time, `alarmFiredAt` is set on the target (the alarm fired in the new Worker).

Also check: the source answers `{"bound": false}` and serves no object.

## Clean up

```bash
$W delete --name custodes-transfer-test-target
$W delete --name custodes-transfer-test-source
```

If a delete refuses because of the Durable Object namespace, first deploy the target with
`"Probe": { "type": "durable-object", "state": "deleted" }` in `exports` and no binding.
