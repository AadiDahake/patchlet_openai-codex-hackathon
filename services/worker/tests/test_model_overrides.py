"""An operator can choose each worker model for one host, and the recorded defaults hold otherwise."""

from __future__ import annotations

import importlib
from collections.abc import Iterator

import pytest

from steps import llm

VARIABLES = ("PATCHLET_ARCHITECT_MODEL", "PATCHLET_EDITOR_MODEL", "PATCHLET_ESCALATION_MODEL")


@pytest.fixture
def reload_llm(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The ids are read when the module loads, so each case reloads it and the last reload restores it."""
    for name in VARIABLES:
        monkeypatch.delenv(name, raising=False)
    yield
    monkeypatch.undo()
    importlib.reload(llm)


def test_the_defaults_hold_when_nothing_is_set(reload_llm: None) -> None:
    importlib.reload(llm)
    assert (llm.ARCHITECT_MODEL, llm.EDITOR_MODEL, llm.ESCALATION_MODEL) == ("gpt-6.2-sol", "gpt-6.1-terra", "gpt-6.2-sol")


def test_each_role_takes_its_own_variable(reload_llm: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATCHLET_ARCHITECT_MODEL", "architect-x")
    monkeypatch.setenv("PATCHLET_EDITOR_MODEL", "editor-y")
    monkeypatch.setenv("PATCHLET_ESCALATION_MODEL", "escalation-z")
    importlib.reload(llm)
    assert (llm.ARCHITECT_MODEL, llm.EDITOR_MODEL, llm.ESCALATION_MODEL) == ("architect-x", "editor-y", "escalation-z")


def test_one_override_leaves_the_others_alone(reload_llm: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATCHLET_EDITOR_MODEL", "  editor-y  ")
    importlib.reload(llm)
    assert (llm.ARCHITECT_MODEL, llm.EDITOR_MODEL, llm.ESCALATION_MODEL) == ("gpt-6.2-sol", "editor-y", "gpt-6.2-sol")


def test_a_blank_variable_is_the_default(reload_llm: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATCHLET_ARCHITECT_MODEL", "   ")
    importlib.reload(llm)
    assert llm.ARCHITECT_MODEL == "gpt-6.2-sol"
