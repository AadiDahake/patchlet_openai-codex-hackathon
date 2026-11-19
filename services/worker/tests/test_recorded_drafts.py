"""A recorded draft replaces the architect and the editor for one request, and says so everywhere."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest
import responses

from models import Draft, FeatureRequestInput, GateOutcome, IssueRef, Plan, PlannedFile
from steps import applier, codegen, db, drafting, github, issue as issue_text, llm, mcp_github, pipeline, recorded, repo, slack
from steps.reporter import NullReporter

API = "https://api.github.com/repos/AadiDahake/novaair"
COMMIT = "58995f2e947c17854174452536068c727faa78c2"
PARENT = "c893a7afcd6ea135755592dcdca5827309d80bcf"
OTHER_HEAD = "1111111111111111111111111111111111111111"
EXAMPLE = Path(__file__).resolve().parents[3] / "docs" / "recorded-drafts" / "novaair-family-seating.json"

BASE_TREE = {
    "lib/seats/index.ts": "export const seats = []\n",
    "tests/no-group-seating.test.ts": "test('no party seating', () => {})\n",
    "docs/api.md": "# API\n",
}
RECORDED = {
    "lib/seats/index.ts": "export const seats = []\nexport function findParty() { return [] }\n",
    "app/api/seats/[flightId]/party/route.ts": "export async function POST() { return Response.json([]) }\n",
}


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


@pytest.fixture
def req() -> FeatureRequestInput:
    return FeatureRequestInput(
        escalation_id="e1", project_id="p1", repo_full_name="AadiDahake/novaair",
        title="Support finding three adjacent seats for families",
        description="Find three seats together.",
        quote="I'm traveling with my two kids. Can you find us three seats together?",
        report_count=1, user_report_count=1,
    )


@pytest.fixture
def rows(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, str, Any]]:
    """The trace as (kind, status, title, detail), in the order a reader sees it."""
    written: list[tuple[str, str, str, Any]] = []

    def fake_emit(project_id, escalation_id, kind, title, status="ok", detail=None, **_kwargs):  # type: ignore[no-untyped-def]
        written.append((kind, status, title, detail))
        return len(written)

    monkeypatch.setattr(db, "emit_trace", fake_emit)
    monkeypatch.setattr(db, "update_escalation", lambda *a, **k: None)
    monkeypatch.setattr(db, "update_group", lambda *a, **k: None)
    monkeypatch.setattr(slack, "notify", lambda _text: True)
    # No linked token: the client falls back to the test GITHUB_TOKEN and never asks the database.
    monkeypatch.setattr(github, "project_token", lambda _project_id: None)
    monkeypatch.setattr(pipeline, "project_token", lambda _project_id: None)
    return written


@pytest.fixture
def no_models(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any model call in a recorded run is a bug, so every door to one fails the test."""

    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a recorded draft must not call a model")

    monkeypatch.setattr(llm, "_create", refuse)
    monkeypatch.setattr(codegen, "plan_changes", refuse)
    monkeypatch.setattr(codegen, "draft_file", refuse)
    monkeypatch.setattr(codegen, "repair_file", refuse)


@pytest.fixture
def clone(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """`repo.clone` writes BASE_TREE into the destination and reports a head the test can move."""
    state: dict[str, Any] = {"head": PARENT, "last": None}

    def fake_clone(_repo: str, _branch: str, dest: Path, token: str | None = None) -> str:
        for path, content in BASE_TREE.items():
            target = dest / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        state["last"] = dest
        return state["head"]

    monkeypatch.setattr(repo, "clone", fake_clone)
    monkeypatch.setattr(repo, "head_sha", lambda _root: state["head"])
    return state


@pytest.fixture
def gates(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """The gates, faked: they record that they ran and answer what the test sets."""
    state: dict[str, Any] = {"installs": 0, "runs": 0, "seen": [], "results": None}

    def install(root: Path, _slug: str) -> applier.GateResult:
        state["installs"] += 1
        return applier.GateResult("npm ci", True, "reused cached node_modules", skipped=True)

    def run(root: Path, _slug: str, install: bool = True) -> list[applier.GateResult]:
        state["runs"] += 1
        state["seen"].append({p: (root / p).read_text() if (root / p).exists() else None for p in [*BASE_TREE, *RECORDED]})
        return state["results"] or [
            applier.GateResult("npm run typecheck", True, "ok", duration_s=9.0),
            applier.GateResult("npm test", True, "ok", duration_s=12.0),
            applier.GateResult("npm run build", True, "ok", duration_s=41.0),
        ]

    monkeypatch.setattr(applier, "ensure_node_modules", install)
    monkeypatch.setattr(applier, "run_gates", run)
    return state


def _write_drafts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **overrides: Any) -> Path:
    entry: dict[str, Any] = {
        "name": "NovaAir family seating",
        "repo": "AadiDahake/novaair",
        "commit": COMMIT,
        "match": {"words": ["seat"], "pattern": "together|adjacent|famil"},
        "summary": "Find three seats together.",
        "acceptance_criteria": ["Three seats together are offered."],
    }
    entry.update(overrides)
    path = tmp_path / "recorded-drafts.json"
    path.write_text(json.dumps({"drafts": [entry]}), encoding="utf-8")
    monkeypatch.setenv(recorded.ENV, str(path))
    return path


def _register_commit(parents: list[str], removed: list[str] | None = None) -> None:
    files: list[dict[str, Any]] = [
        {"filename": "lib/seats/index.ts", "status": "modified", "sha": "blob-index"},
        {"filename": "app/api/seats/[flightId]/party/route.ts", "status": "added", "sha": "blob-route"},
    ]
    files += [{"filename": path, "status": "removed", "sha": "blob-gone"} for path in removed or []]
    responses.get(
        f"{API}/commits/{COMMIT}",
        json={
            "sha": COMMIT,
            "parents": [{"sha": sha} for sha in parents],
            "commit": {"message": "feat: support finding three adjacent seats for families\n\nCloses #51"},
            "files": files,
        },
    )
    responses.get(f"{API}/git/blobs/blob-index", json={"content": _b64(RECORDED["lib/seats/index.ts"]), "encoding": "base64"})
    responses.get(
        f"{API}/git/blobs/blob-route",
        json={"content": _b64(RECORDED["app/api/seats/[flightId]/party/route.ts"]), "encoding": "base64"},
    )


def _issue() -> IssueRef:
    return IssueRef(number=7, url="https://github.com/AadiDahake/novaair/issues/7", title="Support finding three adjacent seats for families", body="body")


def _titles(rows: list[tuple[str, str, str, Any]]) -> list[str]:
    return [title for _kind, _status, title, _detail in rows]


# ---- the whole recorded run ------------------------------------------------------------------

@responses.activate
def test_a_matching_request_uses_the_recording_and_calls_no_model(
    req: FeatureRequestInput, rows: list, clone: dict, gates: dict, no_models: None,
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_drafts(tmp_path, monkeypatch)
    _register_commit([PARENT], removed=["tests/no-group-seating.test.ts"])

    plan = pipeline.inspect_repository(req, _issue())
    assert plan.recording is not None and plan.recording.commit == COMMIT
    assert plan.base_sha == PARENT
    assert plan.summary == "Find three seats together."

    draft = pipeline.draft_implementation(req, _issue(), plan)

    assert draft.files == RECORDED
    assert draft.deletions == ["tests/no-group-seating.test.ts"]
    assert draft.base_sha == PARENT
    assert draft.recording is not None and draft.recording.commit == COMMIT
    assert draft.acceptance_criteria == ["Three seats together are offered."]
    # The gates ran against the recorded files, with the guard test gone.
    assert gates["runs"] == 1
    assert gates["seen"][0]["app/api/seats/[flightId]/party/route.ts"] == RECORDED["app/api/seats/[flightId]/party/route.ts"]
    assert gates["seen"][0]["tests/no-group-seating.test.ts"] is None
    assert [g.name for g in draft.gates] == ["npm run typecheck", "npm test", "npm run build"]

    kinds = [kind for kind, *_ in rows]
    titles = _titles(rows)
    assert "model" not in kinds
    assert not [t for t in titles if t.startswith(("Drafted", "Chose", "Repaired"))]
    assert any(t.startswith(f"Using recorded draft {COMMIT[:7]}") for t in titles)
    assert f"Applied lib/seats/index.ts from recorded draft {COMMIT[:7]}" in titles
    assert f"Applied app/api/seats/[flightId]/party/route.ts from recorded draft {COMMIT[:7]}" in titles
    assert f"Deleted tests/no-group-seating.test.ts as recorded draft {COMMIT[:7]} does" in titles
    assert f"Changes to 3 file(s) from recorded draft {COMMIT[:7]}" in titles


@responses.activate
def test_a_request_that_does_not_match_drafts_normally(
    req: FeatureRequestInput, rows: list, clone: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_drafts(tmp_path, monkeypatch)
    other = req.model_copy(update={"title": "Add a dark mode", "quote": "My eyes hurt at night."})
    planned = Plan(files=[PlannedFile(path="app/globals.css", reason="tokens")], summary="dark", base_sha=PARENT)
    calls: list[str] = []
    monkeypatch.setattr(codegen, "plan_changes", lambda *a, **k: (calls.append("architect"), (planned, "summary"))[1])

    plan = pipeline.inspect_repository(other, _issue())

    assert calls == ["architect"]
    assert plan.recording is None
    assert not [t for t in _titles(rows) if "recorded" in t.lower()]
    # No GitHub call was made for a recording that does not apply.
    assert len(responses.calls) == 0


def test_with_the_variable_unset_nothing_is_recorded(req: FeatureRequestInput, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(recorded.ENV, raising=False)
    reporter = NullReporter()
    assert recorded.load() == []
    assert recorded.plan_for(req, PARENT, reporter) is None
    assert reporter.events == []


@responses.activate
def test_a_parent_mismatch_falls_back_and_says_why(
    req: FeatureRequestInput, rows: list, clone: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_drafts(tmp_path, monkeypatch)
    _register_commit([PARENT])
    clone["head"] = OTHER_HEAD
    planned = Plan(files=[PlannedFile(path="lib/seats/index.ts", reason="party")], summary="model plan", base_sha=OTHER_HEAD)
    calls: list[str] = []
    monkeypatch.setattr(codegen, "plan_changes", lambda *a, **k: (calls.append("architect"), (planned, "summary"))[1])

    plan = pipeline.inspect_repository(req, _issue())

    assert calls == ["architect"]
    assert plan.recording is None
    reason = [title for title in _titles(rows) if title.startswith(f"Recorded draft {COMMIT[:7]} was made on top of")]
    assert reason == [
        f"Recorded draft {COMMIT[:7]} was made on top of {PARENT[:7]}, and main is at {OTHER_HEAD[:7]} now, "
        "so the models draft this change"
    ]


@responses.activate
def test_a_head_that_moves_before_drafting_falls_back_to_the_models(
    req: FeatureRequestInput, rows: list, clone: dict, gates: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_drafts(tmp_path, monkeypatch)
    _register_commit([PARENT])
    plan = pipeline.inspect_repository(req, _issue())
    assert plan.recording is not None
    clone["head"] = OTHER_HEAD

    model_plan = Plan(files=[PlannedFile(path="lib/seats/index.ts", reason="party")], acceptance_criteria=["model criteria"], summary="model plan")
    monkeypatch.setattr(codegen, "plan_changes", lambda *a, **k: (model_plan, "summary"))
    drafted = Draft(files={"lib/seats/index.ts": "model\n"}, summary="model plan", base_sha=OTHER_HEAD)
    monkeypatch.setattr(drafting, "draft_with_gates", lambda *a, **k: drafted)

    draft = pipeline.draft_implementation(req, _issue(), plan)

    assert draft.recording is None
    assert draft.acceptance_criteria == ["model criteria"]
    assert gates["runs"] == 0
    assert any("moved to" in t and "so the models draft this change" in t for t in _titles(rows))


@responses.activate
def test_a_recording_that_fails_a_gate_is_discarded(
    req: FeatureRequestInput, rows: list, clone: dict, gates: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_drafts(tmp_path, monkeypatch)
    _register_commit([PARENT], removed=["tests/no-group-seating.test.ts"])
    plan = pipeline.inspect_repository(req, _issue())
    gates["results"] = [applier.GateResult("npm test", False, "FAIL tests/seat-party.test.ts", duration_s=3.0)]

    model_plan = Plan(files=[PlannedFile(path="lib/seats/index.ts", reason="party")], summary="model plan")
    monkeypatch.setattr(codegen, "plan_changes", lambda *a, **k: (model_plan, "summary"))
    seen_by_editor: dict[str, str | None] = {}

    def fake_draft(root: Path, *_args: Any, **_kwargs: Any) -> Draft:
        # The models start from the clone as it was, not from the discarded recording.
        for path in BASE_TREE:
            seen_by_editor[path] = (root / path).read_text() if (root / path).exists() else None
        seen_by_editor["route"] = "x" if (root / "app/api/seats/[flightId]/party/route.ts").exists() else None
        return Draft(files={"lib/seats/index.ts": "model\n"}, summary="model plan", base_sha=PARENT)

    monkeypatch.setattr(drafting, "draft_with_gates", fake_draft)

    draft = pipeline.draft_implementation(req, _issue(), plan)

    assert draft.recording is None
    assert seen_by_editor == {**BASE_TREE, "route": None}
    assert f"Recorded draft {COMMIT[:7]} failed npm test, so Patchlet discarded it and the models draft this change" in _titles(rows)


# ---- the gates -------------------------------------------------------------------------------

@responses.activate
def test_gates_are_skipped_when_the_entry_says_so(
    req: FeatureRequestInput, rows: list, clone: dict, gates: dict, no_models: None,
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_drafts(tmp_path, monkeypatch, run_gates=False)
    _register_commit([PARENT])

    plan = pipeline.inspect_repository(req, _issue())
    draft = pipeline.draft_implementation(req, _issue(), plan)

    assert gates == {"installs": 0, "runs": 0, "seen": [], "results": None}
    assert draft.gates == []
    assert draft.recording is not None and draft.recording.run_gates is False
    assert f"Skipped the gates: the entry for recorded draft {COMMIT[:7]} sets run_gates to false" in _titles(rows)


@responses.activate
def test_deleted_files_are_deleted_in_the_clone(req: FeatureRequestInput, rows: list, gates: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github, "project_token", lambda _project_id: None)
    root = tmp_path / "clone"
    for path, content in BASE_TREE.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(content)
    monkeypatch.setattr(repo, "head_sha", lambda _root: PARENT)
    _register_commit([PARENT], removed=["tests/no-group-seating.test.ts"])
    _write_drafts(tmp_path, monkeypatch, run_gates=False)
    plan = recorded.plan_for(req, PARENT, NullReporter())
    assert plan is not None
    assert [(f.path, f.action) for f in plan.files] == [
        ("lib/seats/index.ts", "edit"),
        ("app/api/seats/[flightId]/party/route.ts", "create"),
        ("tests/no-group-seating.test.ts", "delete"),
    ]

    draft = recorded.apply(root, req, plan, NullReporter(), "AadiDahake-novaair")

    assert draft is not None
    assert not (root / "tests/no-group-seating.test.ts").exists()
    assert (root / "app/api/seats/[flightId]/party/route.ts").read_text() == RECORDED["app/api/seats/[flightId]/party/route.ts"]
    assert draft.deletions == ["tests/no-group-seating.test.ts"]
    assert {d.path for d in draft.diffs} == {*RECORDED, "tests/no-group-seating.test.ts"}


def test_a_rename_removes_the_old_path_and_creates_the_new_one() -> None:
    planned = recorded._planned_files(
        [{"filename": "lib/new.ts", "previous_filename": "lib/old.ts", "status": "renamed", "sha": "b"}], "abc1234"
    )
    assert [(f.path, f.action) for f in planned] == [("lib/old.ts", "delete"), ("lib/new.ts", "create")]


# ---- the pull request ------------------------------------------------------------------------

def _recorded_draft(gate_list: list[GateOutcome]) -> Draft:
    from models import Recording

    return Draft(
        files=dict(RECORDED),
        deletions=["tests/no-group-seating.test.ts"],
        summary="Find three seats together.",
        acceptance_criteria=["Three seats together are offered."],
        base_sha=PARENT,
        gates=gate_list,
        recording=Recording(name="NovaAir family seating", repo="AadiDahake/novaair", commit=COMMIT, parent=PARENT),
    )


def _register_pr() -> None:
    responses.get(f"{API}/git/commits/{PARENT}", json={"tree": {"sha": "tree0"}})
    responses.post(f"{API}/git/blobs", json={"sha": "blob1"})
    responses.post(f"{API}/git/trees", json={"sha": "tree1"})
    responses.post(f"{API}/git/commits", json={"sha": "commit1"})
    responses.get(f"{API}/git/ref/heads/patchlet/7-support-finding-three-adjacent-seats-for", status=404, json={"message": "Not Found"})
    responses.post(f"{API}/git/refs", json={"ref": "refs/heads/x"})
    responses.get(f"{API}/pulls", json=[])
    responses.post(f"{API}/issues/31/comments", json={"html_url": "https://github.com/x"})


@pytest.mark.parametrize(
    "gate_list",
    [[GateOutcome(name="npm test", ok=True, duration_s=12.0)], []],
    ids=["gates ran", "gates skipped"],
)
@responses.activate
def test_the_gate_comment_names_the_recording(
    req: FeatureRequestInput, rows: list, monkeypatch: pytest.MonkeyPatch, gate_list: list[GateOutcome],
) -> None:
    _register_pr()
    opened: dict[str, str] = {}

    def fake_open(_repo: str, title: str, body: str, branch: str, base: str, rest: Any = None) -> tuple[dict, str, str]:
        opened.update(title=title, body=body, branch=branch)
        return {"number": 31, "html_url": "https://github.com/AadiDahake/novaair/pull/31", "node_id": "PR_31"}, "rest", "created"

    monkeypatch.setattr(mcp_github, "open_draft_pr_with_fallback", fake_open)
    plan = Plan(files=[], acceptance_criteria=["ignored, the draft carries its own"], summary="x")

    ref = pipeline.open_draft_pr(req, _issue(), plan, _recorded_draft(gate_list))

    assert ref.number == 31
    # Same branch, same title and same body shape as a drafted change.
    assert opened["branch"] == "patchlet/7-support-finding-three-adjacent-seats-for"
    assert opened["title"] == "feat: support finding three adjacent seats for families"
    assert "Closes #7" in opened["body"] and "- Three seats together are offered." in opened["body"]
    comments = [json.loads(call.request.body)["body"] for call in responses.calls if call.request.url.endswith("/issues/31/comments")]
    assert len(comments) == 1
    comment = comments[0]
    assert comment.startswith(issue_text.recorded_line(COMMIT))
    assert f"`{COMMIT[:7]}`" in comment and "No model wrote them in this run." in comment
    if gate_list:
        assert "| `npm test` | passed | 12s |" in comment
    else:
        assert "Patchlet did not run the repository's gates against this branch." in comment
    reported = [detail for kind, _s, title, detail in rows if title == "Reported the gate results on PR #31"]
    assert reported and f"recorded draft {COMMIT[:7]}" in reported[0]["result_summary"]
    # The run still ends on the pull request and the pause.
    assert [kind for kind, *_ in rows][-2:] == ["artifact", "pause"]


def test_a_drafted_change_keeps_the_old_gate_comment() -> None:
    comment = issue_text.build_gate_comment([("npm test", True, 4.0)], "https://x/console/activity")
    assert comment.startswith("Patchlet ran the repository's own gates against this branch before opening it.")
    assert "recorded draft" not in comment


# ---- the file --------------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("title", "quote"),
    [
        ("Support finding three adjacent seats for families", ""),
        ("Enable seat selection for families traveling", ""),
        ("Seat a party next to each other", ""),
        ("Group seating", "Can you find us three seats together?"),
    ],
)
def test_the_example_file_matches_the_novaair_seating_request(req: FeatureRequestInput, title: str, quote: str) -> None:
    entries = recorded.load(str(EXAMPLE))
    assert [(e.repo, e.commit, e.run_gates) for e in entries] == [("AadiDahake/novaair", COMMIT, True)]
    asked = req.model_copy(update={"title": title, "quote": quote})
    assert recorded.find(entries, asked) is entries[0]


@pytest.mark.parametrize(
    ("title", "quote", "repo_name"),
    [
        ("Add a dark mode", "My eyes hurt.", "AadiDahake/novaair"),
        ("Bring the family on one booking", "", "AadiDahake/novaair"),
        ("Support finding three adjacent seats for families", "", "someone/else"),
    ],
)
def test_the_example_file_leaves_other_requests_alone(
    req: FeatureRequestInput, title: str, quote: str, repo_name: str
) -> None:
    entries = recorded.load(str(EXAMPLE))
    asked = req.model_copy(update={"title": title, "quote": quote, "repo_full_name": repo_name})
    assert recorded.find(entries, asked) is None


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"commit": "main"}, "full 40-character commit sha"),
        ({"repo": "novaair"}, "owner/name"),
        ({"match": {}}, "needs words, a pattern, or both"),
        ({"match": {"pattern": "("}}, "not a valid pattern"),
        ({"run_gates": "no"}, "true or false"),
    ],
)
def test_a_broken_entry_is_named(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: dict, message: str) -> None:
    path = _write_drafts(tmp_path, monkeypatch, **change)
    with pytest.raises(recorded.RecordedDraftsError, match=message):
        recorded.load(str(path))


def test_a_broken_file_is_ignored_and_said_in_the_trace(
    req: FeatureRequestInput, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "broken.json"
    path.write_text("{not json")
    monkeypatch.setenv(recorded.ENV, str(path))
    reporter = NullReporter()

    assert recorded.plan_for(req, PARENT, reporter) is None
    [(kind, event)] = reporter.events
    assert kind == "status" and event["status"] == "failed"
    assert "ignored the recorded drafts file" in event["title"] and "so the models draft this change" in event["title"]


def test_the_summary_comes_from_the_commit_when_the_entry_has_none() -> None:
    message = "feat(seats): support finding three adjacent seats for families\n\nCloses #51"
    assert recorded.summary_from_message(message) == "Support finding three adjacent seats for families."
