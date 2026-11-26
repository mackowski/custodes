"""Builds the backlog-review eval fixtures from golden case 001 (#132 v1).

    python3 -I to_fixtures.py            # from snapshot.json and prs.json in this directory
    python3 -I to_fixtures.py --fetch    # first refresh prs.json with `gh api` (read-only)

snapshot.json keeps a reduced timeline. The runtime's read tools get GitHub API shapes, so this
script turns each scored issue into what the broker would return at T0:
- the issue;
- its comments;
- a timeline whose cross-references carry the pull request's merge state at T0;
- the referenced pull requests, with `merged_at` blanked if the merge came after T0.

It writes issues/<number>.json. Expected states are in expected.json, normalised to T0; see the
README for the changes from golden.json.
"""

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = "OWASP/CheatSheetSeries"
# Who counts as a maintainer comes from the policy (maintainers), as in the agent's prompt.
MAINTAINERS = {"mackowski", "jmanico", "randomstuff"}


def fetch_prs(numbers):
    out = {}
    for n in numbers:
        raw = subprocess.run(
            ["gh", "api", f"repos/{REPO}/pulls/{n}"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        p = json.loads(raw)
        out[str(n)] = {
            "number": p["number"],
            "title": p["title"],
            "body": p.get("body") or "",
            "state": p["state"],
            "merged_at": p.get("merged_at"),
            "user": {"login": p["user"]["login"]},
        }
    return out


def assoc(login):
    return "MEMBER" if login in MAINTAINERS else "NONE"


def main():
    snap = json.loads((HERE / "snapshot.json").read_text())
    t0 = snap["t0"]
    expected = json.loads((HERE / "expected.json").read_text())
    items = {x["number"]: x for x in snap["items"] if x["kind"] == "issue"}
    pr_numbers = sorted(
        {
            e["source_number"]
            for n in expected["states"]
            for e in items[int(n)]["timeline"]
            if e["event"] == "cross-referenced" and e.get("source_is_pr")
        }
    )
    prs_path = HERE / "prs.json"
    if "--fetch" in sys.argv:
        prs_path.write_text(json.dumps(fetch_prs(pr_numbers), indent=1) + "\n")
    prs = json.loads(prs_path.read_text())

    def at_t0(pr):
        merged = pr["merged_at"] if pr["merged_at"] and pr["merged_at"] < t0 else None
        state = "closed" if merged or (pr["state"] == "closed" and not pr["merged_at"]) else "open"
        return {**pr, "merged_at": merged, "state": state}

    out_dir = HERE / "issues"
    out_dir.mkdir(exist_ok=True)
    for n in expected["states"]:
        i = items[int(n)]
        tl = i["timeline"]
        comments = [
            {
                "user": {"login": e["actor"]},
                "author_association": assoc(e["actor"]),
                "created_at": e["at"],
                "body": e.get("body", ""),
            }
            for e in tl
            if e["event"] == "commented"
        ]
        timeline = []
        for e in tl:
            base = {"event": e["event"], "created_at": e["at"], "actor": {"login": e["actor"]}}
            if e["event"] in ("labeled", "unlabeled"):
                timeline.append({**base, "label": {"name": e["label"]}})
            elif e["event"] in ("assigned", "unassigned"):
                timeline.append({**base, "assignee": {"login": e["assignee"]}})
            elif e["event"] == "cross-referenced":
                src = str(e["source_number"])
                pr = at_t0(prs[src]) if e.get("source_is_pr") and src in prs else None
                issue = {"number": e["source_number"], "repository": {"full_name": REPO}}
                if pr:
                    issue.update(
                        title=pr["title"],
                        state=pr["state"],
                        pull_request={"merged_at": pr["merged_at"]},
                    )
                timeline.append({**base, "source": {"type": "issue", "issue": issue}})
            elif e["event"] == "renamed":
                timeline.append(base)
        last = max([i["created_at"]] + [e["at"] for e in tl])
        fixture = {
            "repo": REPO,
            "number": i["number"],
            "issue": {
                "number": i["number"],
                "title": i["title"],
                "body": i["body"],
                "state": "open",
                "user": {"login": i["author"]},
                "author_association": assoc(i["author"]),
                "labels": [{"name": l} for l in i["labels_at_t0"]],
                "assignees": [{"login": a} for a in i["assignees_at_t0"]],
                "created_at": i["created_at"],
                "updated_at": last,
                "comments": len(comments),
            },
            "comments": comments,
            "timeline": timeline,
            "pulls": {
                str(e["source_number"]): at_t0(prs[str(e["source_number"])])
                for e in tl
                if e["event"] == "cross-referenced" and str(e["source_number"]) in prs
            },
            "now": t0,
        }
        (out_dir / f"{n}.json").write_text(json.dumps(fixture, indent=1) + "\n")
    print(f"wrote {len(expected['states'])} fixtures")


if __name__ == "__main__":
    main()
