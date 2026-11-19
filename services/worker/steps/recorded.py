"""Recorded drafts: a change Patchlet drafted before and a person tested, used again for one request.

A live draft takes minutes and changes from run to run. For a request an operator has already seen
through once, the file named by `PATCHLET_RECORDED_DRAFTS` can point at the commit that answered it,
and the worker then applies that commit's files in place of the architect and the editor. Every
other step is the normal one: the issue, the gates, the branch, the pull request and the pause.

Three rules keep this honest, and `services/worker/README.md` states them for operators:

- The recording is used only while its commit's parent is the head of the default branch. A
  recording made on another base would be a different change, so the run says so and drafts.
- Nothing claims a model wrote a recorded file. The trace and the gate comment name the commit.
- A recording that fails the repository's gates is discarded, and the models draft the change.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import config
from models import Draft, FeatureRequestInput, GateOutcome, Plan, PlannedFile, Recording
from steps import applier, drafting, issue as issue_text, repo
from steps.github import GitHubClient, GitHubError
from steps.reporter import Reporter

ENV = "PATCHLET_RECORDED_DRAFTS"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REFERENCE_LINE_RE = re.compile(r"^\s*(?:closes|fixes|resolves)\s+#\d+\s*$", re.IGNORECASE | re.MULTILINE)
CONVENTIONAL_PREFIX_RE = re.compile(r"^[a-z]+(?:\([^)]*\))?!?:\s*")

log = logging.getLogger("patchlet.recorded")


class RecordedDraftsError(ValueError):
    """The file named by the environment variable cannot be read or does not have the documented shape."""


@dataclass(frozen=True)
class Entry:
    """One line of the file: which request it answers, and the commit that answers it."""

    name: str
    repo: str
    commit: str
    words: tuple[str, ...] = ()
    pattern: re.Pattern[str] | None = None
    run_gates: bool = True
    summary: str = ""
    acceptance_criteria: tuple[str, ...] = ()

    def matches(self, req: FeatureRequestInput) -> bool:
        if self.repo.casefold() != req.repo_full_name.strip().casefold():
            return False
        text = f"{req.title}\n{req.quote}"
        if any(not re.search(rf"\b{re.escape(word)}", text, re.IGNORECASE) for word in self.words):
            return False
        return self.pattern is None or self.pattern.search(text) is not None


# ---- the file -------------------------------------------------------------------

def _strings(value: Any, where: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise RecordedDraftsError(f"{where} must be a list of non-empty strings")
    return tuple(item.strip() for item in value)


def _entry(raw: Any, index: int) -> Entry:
    where = f"drafts[{index}]"
    if not isinstance(raw, dict):
        raise RecordedDraftsError(f"{where} must be an object")
    repo_name = raw.get("repo")
    if not isinstance(repo_name, str) or repo_name.count("/") != 1:
        raise RecordedDraftsError(f"{where}.repo must be an owner/name string")
    commit = raw.get("commit")
    if not isinstance(commit, str) or not SHA_RE.match(commit):
        raise RecordedDraftsError(f"{where}.commit must be a full 40-character commit sha")
    match = raw.get("match")
    if not isinstance(match, dict):
        raise RecordedDraftsError(f"{where}.match must be an object")
    words = _strings(match.get("words"), f"{where}.match.words")
    pattern_text = match.get("pattern")
    pattern: re.Pattern[str] | None = None
    if pattern_text is not None:
        if not isinstance(pattern_text, str) or not pattern_text.strip():
            raise RecordedDraftsError(f"{where}.match.pattern must be a non-empty string")
        try:
            pattern = re.compile(pattern_text, re.IGNORECASE)
        except re.error as error:
            raise RecordedDraftsError(f"{where}.match.pattern is not a valid pattern: {error}") from error
    if not words and pattern is None:
        raise RecordedDraftsError(f"{where}.match needs words, a pattern, or both")
    run_gates = raw.get("run_gates", True)
    if not isinstance(run_gates, bool):
        raise RecordedDraftsError(f"{where}.run_gates must be true or false")
    summary = raw.get("summary", "")
    if not isinstance(summary, str):
        raise RecordedDraftsError(f"{where}.summary must be a string")
    name = raw.get("name", "")
    if not isinstance(name, str):
        raise RecordedDraftsError(f"{where}.name must be a string")
    return Entry(
        name=name.strip() or f"{repo_name}@{commit[:7]}",
        repo=repo_name.strip(),
        commit=commit,
        words=words,
        pattern=pattern,
        run_gates=run_gates,
        summary=summary.strip(),
        acceptance_criteria=_strings(raw.get("acceptance_criteria"), f"{where}.acceptance_criteria"),
    )


def load(path: str | None = None) -> list[Entry]:
    """The entries in the file the environment names, read on every call so an edit applies at once.

    No variable means no recordings, and the worker drafts every request as it always has.
    """
    location = path if path is not None else config.optional(ENV)
    if not location:
        return []
    try:
        data = json.loads(Path(location).read_text(encoding="utf-8"))
    except OSError as error:
        raise RecordedDraftsError(f"cannot read {location}: {error.strerror or error}") from error
    except json.JSONDecodeError as error:
        raise RecordedDraftsError(f"{location} is not valid JSON: {error}") from error
    drafts = data.get("drafts") if isinstance(data, dict) else None
    if not isinstance(drafts, list):
        raise RecordedDraftsError(f"{location} must be an object with a \"drafts\" list")
    return [_entry(raw, index) for index, raw in enumerate(drafts)]


def find(entries: list[Entry], req: FeatureRequestInput) -> Entry | None:
    """The first entry for this repository whose words and pattern all match the request."""
    return next((entry for entry in entries if entry.matches(req)), None)


# ---- the plan -------------------------------------------------------------------

def summary_from_message(message: str) -> str:
    """The commit message as a pull request summary: no conventional prefix, no issue reference."""
    text = REFERENCE_LINE_RE.sub("", message).strip()
    subject, _, rest = text.partition("\n")
    subject = CONVENTIONAL_PREFIX_RE.sub("", subject.strip())
    subject = subject[:1].upper() + subject[1:]
    if subject and not subject.endswith("."):
        subject += "."
    return "\n\n".join(part for part in (subject, rest.strip()) if part)


def _planned_files(files: list[dict[str, Any]], short: str) -> list[PlannedFile]:
    """The commit's changes as plan entries. A rename removes the old path and creates the new one."""
    planned: list[PlannedFile] = []
    reason = f"as recorded draft {short} changes it"
    for item in files:
        status = str(item.get("status") or "")
        path = str(item.get("filename") or "")
        if not path or status == "unchanged":
            continue
        if status == "renamed" and item.get("previous_filename"):
            planned.append(PlannedFile(path=str(item["previous_filename"]), reason=reason, action="delete"))
            planned.append(PlannedFile(path=path, reason=reason, action="create"))
        elif status == "removed":
            planned.append(PlannedFile(path=path, reason=reason, action="delete"))
        elif status in ("added", "copied"):
            planned.append(PlannedFile(path=path, reason=reason, action="create"))
        else:
            planned.append(PlannedFile(path=path, reason=reason, action="edit"))
    return planned


def _drafting_normally(reporter: Reporter, title: str, entry: Entry, state: str = "ok", **detail: object) -> None:
    reporter.status(
        f"{title}, so the models draft this change",
        state,
        {"recording": entry.name, "commit": entry.commit, **detail},
    )


def plan_for(req: FeatureRequestInput, head_sha: str, reporter: Reporter) -> Plan | None:
    """A plan built from a recorded draft for this request, or None to ask the architect.

    None is always said in the trace when a recording was considered, so a reader knows why a
    request they expected to be recorded was drafted.
    """
    try:
        entry = find(load(), req)
    except RecordedDraftsError as error:
        log.warning("recorded drafts ignored: %s", error)
        reporter.status(f"Patchlet ignored the recorded drafts file ({error}), so the models draft this change", "failed")
        return None
    if entry is None:
        return None

    github = GitHubClient.for_project(req.repo_full_name, req.project_id)
    try:
        commit = github.get_commit(entry.commit)
    except GitHubError as error:
        _drafting_normally(reporter, f"Patchlet could not read recorded draft {entry.commit[:7]} ({error})", entry, "failed")
        return None
    parents = [str(parent.get("sha") or "") for parent in commit.get("parents") or []]
    reporter.tool(
        f"Read recorded draft {entry.commit[:7]} from {req.repo_full_name}", "get_commit", "rest",
        f"GET /repos/{req.repo_full_name}/commits/{entry.commit[:7]}",
        f"{len(commit.get('files') or [])} file(s) on top of {', '.join(p[:7] for p in parents) or 'no parent'}",
    )
    if parents != [head_sha]:
        on_top_of = parents[0][:7] if len(parents) == 1 else f"{len(parents)} parents"
        _drafting_normally(
            reporter,
            f"Recorded draft {entry.commit[:7]} was made on top of {on_top_of}, "
            f"and {req.default_branch} is at {head_sha[:7]} now",
            entry,
            parents=parents,
            head=head_sha,
        )
        return None

    planned = _planned_files(list(commit.get("files") or []), entry.commit[:7])
    if not planned:
        _drafting_normally(reporter, f"Recorded draft {entry.commit[:7]} changes no files", entry, "failed")
        return None

    recording = Recording(name=entry.name, repo=entry.repo, commit=entry.commit, parent=head_sha, run_gates=entry.run_gates)
    reporter.status(
        f"Using recorded draft {recording.short} ({entry.name}): "
        f"its {len(planned)} file(s) were drafted and tested before, and no model writes them in this run",
        detail={
            "recording": entry.name,
            "commit": entry.commit,
            "parent": head_sha,
            "runGates": entry.run_gates,
            "files": [{"path": f.path, "action": f.action} for f in planned],
        },
    )
    message = str((commit.get("commit") or {}).get("message") or "")
    return Plan(
        files=planned,
        acceptance_criteria=list(entry.acceptance_criteria) or issue_text.default_acceptance_criteria(req),
        summary=entry.summary or summary_from_message(message) or req.description,
        base_sha=head_sha,
        recording=recording,
    )


# ---- the draft ------------------------------------------------------------------

def _recorded_contents(github: GitHubClient, recording: Recording) -> tuple[dict[str, str], list[str]]:
    """Every file the commit leaves behind, read from its blobs, and every path it removes."""
    commit = github.get_commit(recording.commit)
    files: dict[str, str] = {}
    deletions: list[str] = []
    for planned, item in _paired(list(commit.get("files") or []), recording.short):
        if planned.is_delete:
            deletions.append(planned.path)
        else:
            files[planned.path] = github.get_blob_text(str(item.get("sha") or ""))
    return files, deletions


def _paired(files: list[dict[str, Any]], short: str) -> list[tuple[PlannedFile, dict[str, Any]]]:
    pairs: list[tuple[PlannedFile, dict[str, Any]]] = []
    for item in files:
        for planned in _planned_files([item], short):
            pairs.append((planned, item))
    return pairs


def apply(root: Path, req: FeatureRequestInput, plan: Plan, reporter: Reporter, repo_slug: str) -> Draft | None:
    """Apply the recorded files in the clone and run the gates, or return None to draft normally.

    The clone is left as it was found whenever this returns None.
    """
    recording = plan.recording
    if recording is None:
        return None
    entry_title = f"Recorded draft {recording.short}"
    head = repo.head_sha(root)
    if head != recording.parent:
        reporter.status(
            f"{entry_title} was made on top of {recording.parent[:7]}, and {req.default_branch} moved to "
            f"{head[:7]} before drafting, so the models draft this change",
            detail={"recording": recording.name, "commit": recording.commit, "parent": recording.parent, "head": head},
        )
        return None

    github = GitHubClient.for_project(req.repo_full_name, req.project_id)
    try:
        files, deletions = _recorded_contents(github, recording)
    except GitHubError as error:
        reporter.status(
            f"Patchlet could not read the files of {entry_title.lower()} ({error}), so the models draft this change",
            "failed",
            {"recording": recording.name, "commit": recording.commit},
        )
        return None

    originals = applier.apply_files(root, files, deletions)
    for path, content in files.items():
        before = originals.get(path)
        reporter.tool(
            f"Applied {path} from recorded draft {recording.short}", "apply_recorded_file", "rest",
            f"GET /repos/{req.repo_full_name}/git/blobs for {recording.short}",
            f"{'new file' if before is None else f'{len(before.splitlines())} lines before'}, "
            f"{len(content.splitlines())} lines now",
        )
    for path in deletions:
        reporter.tool(
            f"Deleted {path} as recorded draft {recording.short} does", "delete_file", "fs",
            f"removed by {recording.short}", f"{len((originals.get(path) or '').splitlines())} lines removed",
        )

    gates: list[GateOutcome] = []
    if recording.run_gates:
        install = applier.ensure_node_modules(root, repo_slug)
        drafting.report_gates(reporter, [install], "dependencies")
        if not install.ok:
            applier.restore(root, originals)
            raise RuntimeError("npm ci failed:\n" + install.output[-2000:])
        results = applier.run_gates(root, repo_slug, install=False)
        label = f"recorded draft {recording.short}"
        drafting.report_gates(reporter, results, label)
        failure = next((result for result in results if not result.ok), None)
        if failure is not None:
            applier.restore(root, originals)
            reporter.status(
                f"{entry_title} failed {failure.name}, so Patchlet discarded it and the models draft this change",
                "failed",
                {"recording": recording.name, "commit": recording.commit, "gate": failure.name},
            )
            return None
        gates = [GateOutcome(name=r.name, ok=r.ok, duration_s=r.duration_s) for r in results]
    else:
        reporter.status(
            f"Skipped the gates: the entry for {entry_title.lower()} sets run_gates to false",
            detail={"recording": recording.name, "commit": recording.commit, "runGates": False},
        )

    changed = {path: content for path, content in files.items() if content != originals.get(path)}
    diffs = applier.unified_diffs(originals, changed, deletions)
    return Draft(
        files=changed,
        deletions=deletions,
        diffs=[{"path": d["path"], "patch": d["patch"]} for d in diffs],
        summary=plan.summary,
        base_sha=recording.parent,
        candidates_tried=0,
        repairs=0,
        gates=gates,
        recording=recording,
    )
