# Durable Object transfer rehearsal

A rehearsal of both one-way steps in moving `PrGateAgent` (ADR 0018), on two throwaway Workers:

1. the switch from `migrations` to `exports`, which merging PR #106 makes in `custodes-agents` for
   all six agents;
2. the transfer of a class with its data to another Worker (`agent-cutover.yml`);
3. (steps F and G) what the clean-up PR does to `custodes-agents`: its code no longer has the
   transferred classes, only their `transferred` tombstones remain in `exports`.

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
# What the deploy workflows' guards will see (needs CLOUDFLARE_API_TOKEN with Workers read and
# CLOUDFLARE_ACCOUNT_ID in the environment, e.g. via scripts/with-secrets.sh):
OWNER="node --experimental-strip-types scripts/do-namespace-owner.ts Probe"
SRC=https://custodes-transfer-test-source.<your-subdomain>.workers.dev
TGT=https://custodes-transfer-test-target.<your-subdomain>.workers.dev

# A. Start like custodes-agents: migrations; two objects with data and a pending alarm.
$W deploy -c $T/source.jsonc
curl "$SRC/set?v=hello-a&alarmIn=900000"
curl "$SRC/set?name=b&v=hello-b&alarmIn=900000"
curl "$SRC/" ; curl "$SRC/?name=b"          # note both "id" values
curl "$SRC/gone"                            # a class to delete in B, like HelloAgent

# B. The switch PR #106 makes: migrations -> exports, and `Gone` deleted in the same deploy.
$W deploy -c $T/source-exports.jsonc
curl "$SRC/" ; curl "$SRC/?name=b"          # same ids, values, alarms?
$OWNER                                      # expect: custodes-transfer-test-source

# C. The cutover: target expects, source hands over (no rollback after this), target binds.
$W deploy -c $T/target-expecting.jsonc
$OWNER                                      # expect: custodes-transfer-test-source (only)
$W deploy -c $T/source-transferred.jsonc
$OWNER                                      # expect: custodes-transfer-test-target
$W deploy -c $T/target-final.jsonc
$OWNER                                      # expect: custodes-transfer-test-target
curl "$TGT/" ; curl "$TGT/?name=b"          # same ids, values, alarms?
curl "$SRC/"                                # expect {"bound": false}

# D. What a normal deploy of the old source config would do after the move (the guard in
#    deploy-workers.yml prevents this in production; here we learn what Cloudflare does).
$W deploy -c $T/source-exports.jsonc        # note: refused, or accepted?
curl "$SRC/" ; curl "$TGT/"                 # target data must be untouched
$OWNER                                      # note: target only, or exit 1 (two owners)

# F. The clean-up PR's deploy of custodes-agents: no Durable Object class in the code, the
#    `transferred` tombstone still in exports (the docs do not say whether this is accepted:
#    `config_export_not_in_code` is a possible error). Must succeed.
$W deploy -c $T/source-no-class.jsonc
curl "$SRC/"                                # expect {"bound": false, "note": ...}
curl "$TGT/" ; curl "$TGT/?name=b"          # target data untouched?
$OWNER                                      # expect: custodes-transfer-test-target

# G. Informational, for a later PR: the tombstone dropped too. Note what Cloudflare prints
#    (`stale_tombstone` notices before, anything after) and that the target is untouched.
$W deploy -c $T/source-no-tombstone.jsonc
curl "$TGT/" ; curl "$TGT/?name=b"
$OWNER

# E. After the alarm time (15 min), on the target:
curl "$TGT/" ; curl "$TGT/?name=b"          # "alarmFiredAt" set on both
```

## Pass criteria

Do not mark #106 ready, or run the cutover, unless all hold:

1. Every deploy in A–C succeeds.
2. After B, both objects keep their `id`, `value` and pending `alarm`, and the deploy that drops
   `Gone`'s code and marks it `deleted` succeeds (it is what removes `HelloAgent` in #106).
3. After C, on the target: same `id`s, `value`s `hello-a` / `hello-b`, alarms still set.
4. After C, the source answers `{"bound": false}`.
5. After D, whatever Cloudflare did with the source, the target's data is unchanged. Note the
   outcome (refused, or a new empty namespace) in PR #106.
6. After E, `alarmFiredAt` is set on both target objects.
7. The owner checks print, in order: source (after B); source only (after `target-expecting`);
   target (after `source-transferred`); target (after `target-final`). The cutover workflow's
   `full` and `final-only` guards rely on exactly this. After D, note whether it printed the target or
   exited 1; either is safe (the guard refuses), but write it down in PR #106.

For the clean-up PR (steps F and G), do not merge it unless:

8. After F, the deploy succeeds and the target's `id`s, `value`s and alarms are unchanged, and the
   owner check still prints the target. If F fails, keep the class exports in
   `workers/agents/src/index.ts` (and the test entry's) until the error is understood.
9. After G, note the outcome in the PR (accepted, refused, any notice). It decides when the
   tombstones can go; the clean-up PR kept them. They were dropped on 2026-11-16 (#146), after
   every production deploy reported them `stale_tombstone`.

## Clean up

```bash
$W delete --name custodes-transfer-test-target
$W delete --name custodes-transfer-test-source
```

If a delete refuses because of the Durable Object namespace, first deploy that Worker with
`"Probe": { "type": "durable-object", "state": "deleted" }` in `exports`, no binding, and code
that no longer exports `Probe` (Cloudflare refuses a tombstone for a class the code still exports:
`tombstone_delete_class_still_in_code`).
