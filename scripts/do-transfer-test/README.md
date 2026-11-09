# Durable Object transfer rehearsal

A rehearsal of both one-way steps in moving `PrGateAgent` (ADR 0018), on two throwaway Workers:

1. the switch from `migrations` to `exports`, which merging PR #106 makes in `custodes-agents` for
   all six agents;
2. the transfer of a class with its data to another Worker (`pr-gate-cutover.yml`).

The Cloudflare docs do not state whether SQLite data, alarms and object ids survive these. **Run it
before PR #106 is marked ready**: the first step ships with the merge.

Nothing here touches Custodes Workers or data. The Workers are `custodes-transfer-test-source` and
`custodes-transfer-test-target`, on `workers.dev`. Run it by hand with your own wrangler login, not
from a Claude session (CLAUDE.md invariant 5).

## Run

From the repository root, using the repo's pinned wrangler (`pnpm --filter ./workers/agents exec
wrangler login` once):

```bash
W="pnpm --filter ./workers/agents exec wrangler"
T=../../scripts/do-transfer-test
SRC=https://custodes-transfer-test-source.<your-subdomain>.workers.dev
TGT=https://custodes-transfer-test-target.<your-subdomain>.workers.dev

# A. Start like custodes-agents: migrations; two objects with data and a pending alarm.
$W deploy -c $T/source.jsonc
curl "$SRC/set?v=hello-a&alarmIn=900000"
curl "$SRC/set?name=b&v=hello-b&alarmIn=900000"
curl "$SRC/" ; curl "$SRC/?name=b"          # note both "id" values

# B. The switch PR #106 makes: migrations -> exports.
$W deploy -c $T/source-exports.jsonc
curl "$SRC/" ; curl "$SRC/?name=b"          # same ids, values, alarms?

# C. The cutover: target expects, source hands over (no rollback after this), target binds.
$W deploy -c $T/target-expecting.jsonc
$W deploy -c $T/source-transferred.jsonc
$W deploy -c $T/target-final.jsonc
curl "$TGT/" ; curl "$TGT/?name=b"          # same ids, values, alarms?
curl "$SRC/"                                # expect {"bound": false}

# D. What a normal deploy of the old source config would do after the move (the guard in
#    deploy-workers.yml prevents this in production; here we learn what Cloudflare does).
$W deploy -c $T/source-exports.jsonc        # note: refused, or accepted?
curl "$SRC/" ; curl "$TGT/"                 # target data must be untouched

# E. After the alarm time (15 min), on the target:
curl "$TGT/" ; curl "$TGT/?name=b"          # "alarmFiredAt" set on both
```

## Pass criteria

Do not mark #106 ready, or run the cutover, unless all hold:

1. Every deploy in A–C succeeds.
2. After B, both objects keep their `id`, `value` and pending `alarm`.
3. After C, on the target: same `id`s, `value`s `hello-a` / `hello-b`, alarms still set.
4. After C, the source answers `{"bound": false}`.
5. After D, whatever Cloudflare did with the source, the target's data is unchanged. Note the
   outcome (refused, or a new empty namespace) in PR #106.
6. After E, `alarmFiredAt` is set on both target objects.

## Clean up

```bash
$W delete --name custodes-transfer-test-target
$W delete --name custodes-transfer-test-source
```

If a delete refuses because of the Durable Object namespace, first deploy that Worker with
`"Probe": { "type": "durable-object", "state": "deleted" }` in `exports` and no binding.
