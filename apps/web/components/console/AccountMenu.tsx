"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/console/ConfirmDialog";
import { browserSupabase } from "@/lib/auth/browser";
import { describeReset, describeSitePreview, type ResultLine, type SitePreview } from "@/lib/demo/describe";
import type { ResetSummary } from "@/lib/demo/reset";

type Props = {
  email: string;
  /** The company the account signed up as. The project slug is never shown to a person. */
  company: string | null;
  /** The linked GitHub login, when the project has one. */
  githubLogin: string | null;
};

/** Two letters from the company name, else the first two of the address. */
function initials(email: string, company: string | null): string {
  const source = company?.trim() || email;
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

/** Who is signed in, what GitHub account is linked, and the way out. */
export function AccountMenu({ email, company, githubLogin }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [askingReset, setAskingReset] = useState(false);
  const [sitePreview, setSitePreview] = useState<SitePreview | null>(null);
  const [sitePreviewError, setSitePreviewError] = useState("");
  const [resetDone, setResetDone] = useState<ResultLine[]>([]);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement | null>(null);
  // Only the newest check may fill the dialog, if it is closed and opened again while one runs.
  const previewRequest = useRef(0);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function disconnectGithub() {
    setUnlinking(true);
    setError("");
    try {
      const response = await fetch("/api/github/disconnect", { method: "POST" });
      if (!response.ok) throw new Error("GitHub could not be disconnected.");
      setOpen(false);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "GitHub could not be disconnected.");
    } finally {
      setUnlinking(false);
    }
  }

  /** Opens the confirmation and asks what a reset would do to the demo site's code. */
  async function askReset() {
    const request = ++previewRequest.current;
    setAskingReset(true);
    setSitePreview(null);
    setSitePreviewError("");
    try {
      const response = await fetch("/api/demo/reset");
      const body = (await response.json()) as Partial<SitePreview> & { error?: string };
      if (!response.ok || !body.main || !body.site || !body.productMap) {
        throw new Error(body.error ?? "The demo site's code could not be checked.");
      }
      const preview = { main: body.main, site: body.site, productMap: body.productMap };
      if (request === previewRequest.current) setSitePreview(preview);
    } catch (failure) {
      if (request !== previewRequest.current) return;
      setSitePreviewError(failure instanceof Error ? failure.message : "The demo site's code could not be checked.");
    }
  }

  async function resetDemo() {
    setResetting(true);
    setError("");
    setResetDone([]);
    try {
      const response = await fetch("/api/demo/reset", { method: "POST" });
      const body = (await response.json()) as { summary?: ResetSummary; error?: string };
      if (!response.ok || !body.summary) throw new Error(body.error ?? "The demo could not be reset.");
      setResetDone(describeReset(body.summary));
      setAskingReset(false);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The demo could not be reset.");
      setAskingReset(false);
    } finally {
      setResetting(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    await browserSupabase().auth.signOut();
    router.replace("/signin");
    router.refresh();
  }

  return (
    <div className="account" ref={root}>
      {githubLogin ? (
        <span className="account-github" title={`Connected as @${githubLogin}`}>
          <GithubGlyph />
          <span className="sr-only">GitHub connected as @{githubLogin}</span>
        </span>
      ) : null}

      <button
        type="button"
        className={`account-trigger${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="account-trigger__avatar" aria-hidden="true">
          {initials(email, company)}
        </span>
        <span className="account-trigger__label">
          {company ? <span className="account-trigger__company">{company}</span> : null}
          <span className="account-trigger__email">{email}</span>
        </span>
        <svg className="account-trigger__chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div className="account-menu" role="menu">
          <div className="account-menu__header">
            {company ? <span className="account-menu__company">{company}</span> : null}
            <span className="account-menu__email">{email}</span>
          </div>
          <div className="account-menu__divider" />
          {githubLogin ? (
            <div className="account-menu__row">
              <span className="account-menu__github">
                <GithubGlyph />@{githubLogin}
              </span>
              <button
                type="button"
                className="link-button"
                onClick={() => void disconnectGithub()}
                disabled={unlinking}
              >
                {unlinking ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          ) : (
            <a className="account-menu__item" role="menuitem" href="/api/github/connect">
              Link GitHub
            </a>
          )}
          {error ? <p className="account-menu__error">{error}</p> : null}
          {resetDone.map((line, index) => (
            <p key={index} className={line.problem ? "account-menu__error" : "account-menu__note"}>
              {keepTagTogether(line.text)}
              {line.link ? (
                <>
                  {" "}
                  <a className="ext-link" href={line.link.href} target="_blank" rel="noreferrer">
                    {line.link.label}
                  </a>
                </>
              ) : null}
            </p>
          ))}
          <button
            type="button"
            role="menuitem"
            className="account-menu__item"
            onClick={() => void askReset()}
            disabled={resetting}
          >
            {resetting ? "Resetting the demo..." : "Reset demo"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="account-menu__item account-menu__item--danger"
            onClick={() => void signOut()}
            disabled={signingOut}
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      ) : null}

      {askingReset ? (
        <ConfirmDialog
          title="Reset the demo?"
          body={
            <>
              <p>
                Every conversation, every reported request and the whole trace are deleted. On the
                connected repository, the issues and pull requests Patchlet opened are closed and
                its branches are removed.
              </p>
              {sitePreview ? (
                describeSitePreview(sitePreview).map((line) => <p key={line}>{keepTagTogether(line)}</p>)
              ) : sitePreviewError ? (
                <p>
                  {sitePreviewError} A reset still moves main back to the demo-baseline tag when it
                  is safe, which removes every change merged into the demo site since then.
                </p>
              ) : (
                <p>Checking the demo site&apos;s code on GitHub...</p>
              )}
              <p>The knowledge base is left exactly as it is.</p>
            </>
          }
          confirmLabel="Reset demo"
          typeToConfirm="reset"
          busy={resetting}
          loading={!sitePreview && !sitePreviewError}
          onConfirm={() => void resetDemo()}
          onCancel={() => setAskingReset(false)}
        />
      ) : null}
    </div>
  );
}

/** Keeps the tag's name on one line; the browser would otherwise break it at its hyphen. */
function keepTagTogether(text: string): React.ReactNode[] {
  return text.split(/(demo-baseline)/).map((part, index) =>
    part === "demo-baseline" ? (
      <span key={index} className="whitespace-nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function GithubGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38l-.01-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
