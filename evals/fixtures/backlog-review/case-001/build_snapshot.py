"""Reconstruct the state of OWASP/CheatSheetSeries open issues and PRs at T0.

Usage: python3 -I build_snapshot.py OUT_DIR
Reads via `gh api` (public data). Everything after T0 is filtered out.
"""
import json, subprocess, sys, pathlib

REPO = "OWASP/CheatSheetSeries"
T0 = "2026-11-17T07:30:00Z"
# Head SHA of each open PR at T0, recorded by the session's first read (later force-pushes rewrote some).
HEADS_AT_T0 = {
    2982: "b67806df13084969899a7a746b3afb43d6ff7627",
    2981: "cc9c97635a9e801c3c77d868ac072c22284a26b4",
    2976: "fc96d6011dfd8585f68ccc68a1e2c2c371bdd698",
    2972: "99cedf87675ae0af2df887ddf7db916c0b725596",
    2970: "d82cd4f246f18afbfabf5543742bfc38bd98b2f7",
    2955: "cd75a11782fa1d6d09ec1e3362f39e8dcd4c9688",
    2946: "4ca982023df0c1014e2d9720a880f678de485c59",
    2941: "b40f5e2429ea468c8b027c9bba1278d7d8b7e062",
    2934: "c3bb2fedb819ff78d1aa1273166429f796223a60",
    2901: "2069aa61a7b961f2b2b892a73124d3cc4d40eee5",
}


def gh(path, paginate=False):
    cmd = ["gh", "api", path] + (["--paginate", "--slurp"] if paginate else [])
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    if paginate:
        flat = []
        for page in data:
            flat.extend(page if isinstance(page, list) else [page])
        return flat
    return data


def before(ts):
    return ts is not None and ts < T0


def ev_time(e):
    return e.get("created_at") or e.get("submitted_at") or (e.get("committer") or {}).get("date")


def user(o):
    return (o or {}).get("login")


def candidates():
    items = gh(f"repos/{REPO}/issues?state=all&sort=created&direction=desc&per_page=100", paginate=False)
    for page in (2, 3, 4):
        items += gh(f"repos/{REPO}/issues?state=all&sort=created&direction=desc&per_page=100&page={page}")
    seen, out = set(), []
    for it in items:
        n = it["number"]
        if n in seen or not before(it["created_at"]):
            continue
        seen.add(n)
        closed = it.get("closed_at")
        if closed is None or closed >= T0:
            out.append(it)
    return out


def timeline(n):
    tl = gh(f"repos/{REPO}/issues/{n}/timeline?per_page=100", paginate=True)
    keep = []
    for e in tl:
        t = ev_time(e)
        if not before(t):
            continue
        rec = {"event": e.get("event"), "at": t, "actor": user(e.get("actor") or e.get("user") or e.get("author"))}
        if e.get("event") in ("labeled", "unlabeled"):
            rec["label"] = e["label"]["name"]
        elif e.get("event") in ("assigned", "unassigned"):
            rec["assignee"] = user(e.get("assignee"))
        elif e.get("event") == "commented":
            rec["body"] = e.get("body")
        elif e.get("event") == "reviewed":
            rec.update(state=e.get("state"), body=e.get("body"), commit_id=e.get("commit_id"))
        elif e.get("event") == "committed":
            rec.update(sha=e.get("sha"), message=e.get("message"))
        elif e.get("event") == "cross-referenced":
            src = (e.get("source") or {}).get("issue") or {}
            rec.update(source_number=src.get("number"), source_is_pr="pull_request" in src)
        elif e.get("event") in ("review_requested", "review_request_removed"):
            rec["reviewer"] = user(e.get("requested_reviewer"))
        keep.append(rec)
    return keep


def labels_at_t0(tl):
    labels = []
    for e in tl:
        if e["event"] == "labeled" and e["label"] not in labels:
            labels.append(e["label"])
        elif e["event"] == "unlabeled" and e["label"] in labels:
            labels.remove(e["label"])
    return labels


def assignees_at_t0(tl):
    a = []
    for e in tl:
        if e["event"] == "assigned" and e["assignee"] not in a:
            a.append(e["assignee"])
        elif e["event"] == "unassigned" and e["assignee"] in a:
            a.remove(e["assignee"])
    return a


def pr_extra(n, head):
    pr = gh(f"repos/{REPO}/pulls/{n}")
    threads = [
        {"id": c["id"], "in_reply_to": c.get("in_reply_to_id"), "author": user(c["user"]), "at": c["created_at"],
         "path": c["path"], "line": c.get("line") or c.get("original_line"), "body": c["body"]}
        for c in gh(f"repos/{REPO}/pulls/{n}/comments?per_page=100", paginate=True) if before(c["created_at"])
    ]
    cmp = gh(f"repos/{REPO}/compare/{pr['base']['ref']}...{head}")
    files = [{"path": f["filename"], "status": f["status"], "additions": f["additions"], "deletions": f["deletions"],
              "patch": f.get("patch")} for f in cmp.get("files", [])]
    runs = gh(f"repos/{REPO}/actions/runs?head_sha={head}&per_page=100").get("workflow_runs", [])
    runs = [{"id": r["id"], "workflow": r["name"], "created_at": r["created_at"],
             "status_now": r["status"], "conclusion_now": r["conclusion"],
             "note": "status/conclusion are as of snapshot build time, not T0; action_required = held for fork approval"}
            for r in runs if before(r["created_at"])]
    return {
        "head_sha_at_t0": head, "base": pr["base"]["ref"], "draft": pr["draft"],
        "author": user(pr["user"]), "head_repo": (pr["head"]["repo"] or {}).get("full_name"),
        "maintainer_can_modify": pr.get("maintainer_can_modify"),
        "merge_base_ahead_by": cmp.get("ahead_by"), "behind_by": cmp.get("behind_by"),
        "files": files, "review_comments": threads, "workflow_runs": runs,
    }


def main(out):
    out = pathlib.Path(out)
    items = []
    for it in candidates():
        n = it["number"]
        is_pr = "pull_request" in it
        if is_pr and n not in HEADS_AT_T0:
            print(f"skip PR {n}: no recorded head at T0", file=sys.stderr)
            continue
        tl = timeline(n)
        state_events = [e["event"] for e in tl if e["event"] in ("closed", "reopened")]
        if state_events and state_events[-1] == "closed":
            print(f"skip {n}: closed at T0", file=sys.stderr)
            continue
        rec = {"number": n, "kind": "pr" if is_pr else "issue", "title": it["title"], "author": user(it["user"]),
               "created_at": it["created_at"], "body": it["body"],
               "labels_at_t0": labels_at_t0(tl), "assignees_at_t0": assignees_at_t0(tl), "timeline": tl}
        if is_pr:
            rec["pr"] = pr_extra(n, HEADS_AT_T0[n])
        items.append(rec)
        print(f"ok {rec['kind']} {n}", file=sys.stderr)
    snap = {"repo": REPO, "t0": T0, "items": sorted(items, key=lambda r: -r["number"])}
    (out / "snapshot.json").write_text(json.dumps(snap, indent=1))
    print(f"{len(items)} items", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
