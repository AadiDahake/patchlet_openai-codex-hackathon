"""The one place the worker talks to a model provider.

Model ids live here and nowhere else, so a model change is one edit. An operator can override
each role's id for one host with `PATCHLET_ARCHITECT_MODEL`, `PATCHLET_EDITOR_MODEL` and
`PATCHLET_ESCALATION_MODEL`; the defaults below hold when those are unset. The calls go through the
Responses API, which is what the OpenAI documentation presents as the primary API for structured
output and for tool calls. See `docs/contracts.md` section 5 for each choice and its reason.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from openai import OpenAI

import config


def _model(variable: str, default: str) -> str:
    """The id an operator set in the environment for this role, or the default chosen below.

    The override exists so an operator can change a model for one host without a code change. The
    defaults are the recorded choices in `docs/contracts.md` section 5.
    """
    return config.optional(variable, default)


# Priority judgements, issue text, the change plan and the issue filing call: the strong model,
# because the writing and the file choice both stand on their own in a pull request a human reads,
# and the plan decides what every later call writes. These are a few input-heavy calls per run.
ARCHITECT_MODEL = _model("PATCHLET_ARCHITECT_MODEL", "gpt-6.2-sol")
# The first draft of every file. Most runs pass their gates on this draft, so the cheaper model
# writes it and the strong model is paid for only when a gate says the draft is wrong.
EDITOR_MODEL = _model("PATCHLET_EDITOR_MODEL", "gpt-6.1-terra")
# Every editor call after the first gate failure in a run: each repair and each fresh candidate.
ESCALATION_MODEL = _model("PATCHLET_ESCALATION_MODEL", "gpt-6.2-sol")

log = logging.getLogger("patchlet.llm")

_client: OpenAI | None = None


def client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=config.openai_api_key())
    return _client


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def usage_of(response: Any) -> dict[str, int]:
    """The token counts the API reported for one response, with the names the cost log uses.

    Reasoning is left out when the API does not report it, so a zero is a real zero.
    """
    usage = getattr(response, "usage", None)
    if usage is None:
        return {}
    counts: dict[str, int | None] = {
        "input": _count(getattr(usage, "input_tokens", None)),
        "cached_input": _count(getattr(getattr(usage, "input_tokens_details", None), "cached_tokens", None)),
        "output": _count(getattr(usage, "output_tokens", None)),
        "reasoning": _count(getattr(getattr(usage, "output_tokens_details", None), "reasoning_tokens", None)),
    }
    return {name: value for name, value in counts.items() if value is not None}


def _log_usage(model: str, response: Any) -> None:
    """One INFO line per call: the model and its token counts. Never the prompt, never a key."""
    usage = usage_of(response)
    log.info(
        "model call model=%s %s",
        model,
        " ".join(f"{name}={value}" for name, value in usage.items()) or "usage=unreported",
        extra={"model": model, "usage": usage},
    )


def _create(model: str, **kwargs: Any) -> Any:
    response = client().responses.create(model=model, **kwargs)
    _log_usage(model, response)
    return response


def _text(response: Any) -> str:
    """Reasoning models put thinking items beside the text, so every reader takes the flat form."""
    return getattr(response, "output_text", None) or ""


def _input(system: str, user: str) -> list[dict[str, str]]:
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def complete(model: str, system: str, user: str, effort: str = "medium", max_tokens: int = 32000) -> str:
    response = _create(
        model,
        input=_input(system, user),
        max_output_tokens=max_tokens,
        reasoning={"effort": effort},
    )
    return _text(response)


def complete_json(model: str, system: str, user: str, schema_name: str, schema: dict[str, Any]) -> dict[str, Any]:
    response = _create(
        model,
        input=_input(system, user),
        text={
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "schema": schema,
                "strict": True,
            }
        },
    )
    return json.loads(_text(response))


def function_call(model: str, system: str, user: str, tools: list[dict[str, Any]], tool_name: str) -> dict[str, Any]:
    """Ask the model to call one function tool and return the arguments it chose."""
    response = _create(
        model,
        input=_input(system, user),
        tools=tools,
        tool_choice="required",
    )
    for item in getattr(response, "output", None) or []:
        if getattr(item, "type", "") == "function_call" and getattr(item, "name", "") == tool_name:
            arguments = getattr(item, "arguments", "")
            return json.loads(arguments) if isinstance(arguments, str) else dict(arguments)
    raise RuntimeError(f"model did not call {tool_name}")
