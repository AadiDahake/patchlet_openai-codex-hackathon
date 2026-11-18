"""The cheaper editor writes the first draft; the first failed gate hands the rest of the run to the strong model."""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from models import FeatureRequestInput, Plan, PlannedFile
from steps import applier, drafting, llm
from steps.reporter import NullReporter

PASS = [
    applier.GateResult(name="npm run typecheck", ok=True, output="ok"),
    applier.GateResult(name="npm run build", ok=True, output="built"),
]
FAIL = [
    applier.GateResult(name="npm run typecheck", ok=False, output="components/Toggle.tsx(3,1): error TS2304: Cannot find name 'x'."),
]


def _request() -> FeatureRequestInput:
    return FeatureRequestInput(
        escalation_id="esc",
        project_id="proj",
        repo_full_name="owner/repo",
        title="Add a dark mode toggle",
        description="A toggle in the header.",
    )


def _plan() -> Plan:
    return Plan(
        files=[
            PlannedFile(path="components/Toggle.tsx", reason="the control", action="create"),
            PlannedFile(path="styles/tokens.css", reason="the dark tokens", action="edit"),
        ],
        acceptance_criteria=["the toggle switches the theme"],
        summary="dark mode",
        base_sha="abc1234",
    )


def _repo(tmp_path: Path) -> Path:
    (tmp_path / "styles").mkdir()
    (tmp_path / "styles" / "tokens.css").write_text(":root { --bg: white; }\n")
    return tmp_path


class Run:
    """Scripted gates and a recording editor: every model call says which model it went to and why."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, gates: list[list[applier.GateResult]]) -> None:
        self.calls: list[tuple[str, str]] = []
        self._gates = list(gates)
        monkeypatch.setattr(applier, "ensure_node_modules", lambda root, slug: applier.GateResult("npm ci", True, "installed"))
        monkeypatch.setattr(applier, "run_gates", self._run_gates)
        monkeypatch.setattr(llm, "complete", self._complete)

    def _run_gates(self, root: Path, repo_slug: str, install: bool = True) -> list[applier.GateResult]:
        return self._gates.pop(0)

    def _complete(self, model: str, system: str, user: str, **_: Any) -> str:
        kind = "repair" if "The build gate failed" in user else "draft"
        self.calls.append((model, kind))
        return f"/* {kind} {len(self.calls)} */\n"

    def models(self, kind: str) -> list[str]:
        return [model for model, call_kind in self.calls if call_kind == kind]


def _draft(tmp_path: Path, reporter: NullReporter) -> Any:
    return drafting.draft_with_gates(_repo(tmp_path), _request(), "Dark mode", "body", _plan(), reporter, "fixture")


def _escalations(reporter: NullReporter) -> list[dict[str, Any]]:
    return [event for kind, event in reporter.events if kind == "status" and event["title"].startswith("Escalated")]


def test_a_run_whose_gates_pass_first_time_never_calls_the_escalation_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = Run(monkeypatch, [PASS])
    reporter = NullReporter()

    draft = _draft(tmp_path, reporter)

    assert draft.candidates_tried == 1 and draft.repairs == 0
    assert run.calls == [(llm.EDITOR_MODEL, "draft"), (llm.EDITOR_MODEL, "draft")]
    assert _escalations(reporter) == []
    drafted = [event for kind, event in reporter.events if kind == "model"]
    assert [event["model"] for event in drafted] == [llm.EDITOR_MODEL, llm.EDITOR_MODEL]
    assert all(f"with {llm.EDITOR_MODEL}" in event["title"] for event in drafted)


def test_after_a_failed_gate_the_repairs_go_to_the_escalation_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = Run(monkeypatch, [FAIL, PASS])
    reporter = NullReporter()

    draft = _draft(tmp_path, reporter)

    assert draft.repairs == 1
    assert run.models("draft") == [llm.EDITOR_MODEL, llm.EDITOR_MODEL]
    # The gate names only the toggle, so only the toggle is repaired.
    assert run.models("repair") == [llm.ESCALATION_MODEL]
    [escalation] = _escalations(reporter)
    assert escalation["detail"] == {"gate": "npm run typecheck", "model": llm.ESCALATION_MODEL}
    assert "npm run typecheck failed" in escalation["title"] and llm.ESCALATION_MODEL in escalation["title"]
    [repaired] = [event for kind, event in reporter.events if kind == "model" and event["title"].startswith("Repaired")]
    assert repaired["model"] == llm.ESCALATION_MODEL
    assert f"Repaired components/Toggle.tsx with {llm.ESCALATION_MODEL}" in repaired["title"]


def test_a_fresh_candidate_after_a_failed_one_is_drafted_on_the_escalation_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = Run(monkeypatch, [FAIL] * (1 + drafting.MAX_REPAIRS) + [PASS])
    reporter = NullReporter()

    draft = _draft(tmp_path, reporter)

    assert draft.candidates_tried == 2
    assert run.models("draft") == [llm.EDITOR_MODEL] * 2 + [llm.ESCALATION_MODEL] * 2
    assert run.models("repair") == [llm.ESCALATION_MODEL] * drafting.MAX_REPAIRS
    # The switch happens once per run, not once per failed gate.
    assert len(_escalations(reporter)) == 1
    second = [event for kind, event in reporter.events if kind == "model" and "(candidate 2)" in event["title"]]
    assert [event["model"] for event in second] == [llm.ESCALATION_MODEL] * 2


def test_every_model_call_logs_its_model_and_token_usage_and_nothing_of_the_prompt(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    usage = SimpleNamespace(
        input_tokens=1200,
        input_tokens_details=SimpleNamespace(cached_tokens=1024),
        output_tokens=340,
        output_tokens_details=SimpleNamespace(reasoning_tokens=120),
    )
    response = SimpleNamespace(output_text="done", usage=usage, output=[])
    fake = SimpleNamespace(responses=SimpleNamespace(create=lambda **kwargs: response))
    monkeypatch.setattr(llm, "_client", fake)

    with caplog.at_level(logging.INFO, logger="patchlet.llm"):
        assert llm.complete(llm.EDITOR_MODEL, "a secret system prompt", "a private user prompt") == "done"

    [record] = caplog.records
    assert record.levelno == logging.INFO
    assert record.getMessage() == f"model call model={llm.EDITOR_MODEL} input=1200 cached_input=1024 output=340 reasoning=120"
    assert record.usage == {"input": 1200, "cached_input": 1024, "output": 340, "reasoning": 120}
    assert "prompt" not in record.getMessage()


def test_reasoning_is_left_out_of_the_log_when_the_api_does_not_report_it() -> None:
    usage = SimpleNamespace(input_tokens=10, input_tokens_details=None, output_tokens=5, output_tokens_details=None)
    assert llm.usage_of(SimpleNamespace(usage=usage)) == {"input": 10, "output": 5}
    assert llm.usage_of(SimpleNamespace()) == {}
