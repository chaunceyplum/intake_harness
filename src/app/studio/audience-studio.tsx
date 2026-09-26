"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SegmentSizeEstimate } from "@/lib/agents/audience/aep";
import type { LiveToolCall } from "../live-tool-call-log";
import {
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  ExclamationIcon,
  InfoIcon,
  PeopleIcon,
  QuestionIcon,
  SparkleIcon,
  Spinner,
} from "./icons";
import { DeveloperPanel } from "./developer-panel";
import {
  STAGES,
  currentStage,
  friendlySize,
  outcomeOf,
  type AudienceSummary,
  type Outcome,
  type PendingQuestion,
  type RunDetail,
} from "./outcome";
import { useDeveloperMode } from "./use-developer-mode";

/** Briefs that read well out loud and are known to build cleanly on the demo sandbox's CB fields. */
const SUGGESTIONS = [
  "Businesses eligible for Security Edge Preferred that don't already have it",
  "Comcast Business Internet customers who don't have Comcast Business Mobile",
  "Companies with more than 50 employees that have CBM",
  "SEP eligible CB Internet customers with a valid email, not on the do-not-contact list",
];

const RUN_POLL_MS = 1200;
const LIVE_POLL_MS = 800;
/** Past this with no progress, offer a retry instead of an endless spinner. */
const STUCK_AFTER_MS = 4 * 60_000;

/**
 * The executive-facing Audience Studio: describe an audience in plain English,
 * watch it being built in three plain stages, and get a clear result - the
 * audience's name, what it contains, and where it lives.
 *
 * It hides the machinery on purpose (no agent names, tool calls or PQL - see
 * outcome.ts), and shows it all in Developer mode. Without Developer mode it
 * always runs in Demo mode: the tapdemo sandbox, no Workfront request, no
 * activation. Developer mode can switch to Governed.
 *
 * A new request starts with `async: true` (see api/runs/route.ts) and the
 * page polls the run, so the stages track the agents actually running.
 * Answering a question or approving a step is a single request, during which
 * the live feed (api/runs/[runId]/live) drives the stages instead.
 */
export function AudienceStudio() {
  const [developer, setDeveloper] = useDeveloperMode();
  const [brief, setBrief] = useState("");
  const [mode, setMode] = useState<"demo" | "governed">("demo");
  const [workfrontProjectId, setWorkfrontProjectId] = useState("");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveTaskId, setLiveTaskId] = useState<string | null>(null);
  const [liveCalls, setLiveCalls] = useState<LiveToolCall[]>([]);
  const [stuck, setStuck] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const runMode = developer ? mode : "demo";
  const running = detail?.run.status === "running";
  const active = busy || running;
  const runId = detail?.run.run_id ?? null;

  // Follow the run while it is being built: the run itself (only when the
  // page isn't already waiting on a request that returns it) and the live
  // feed that says which agent is working.
  useEffect(() => {
    if (!active || !runId) return;
    let cancelled = false;
    const started = Date.now();

    const pollRun = async () => {
      if (busy) return;
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok || cancelled) return;
        const next = (await res.json()) as RunDetail;
        if (cancelled) return;
        setDetail(next);
        setStuck(next.run.status === "running" && Date.now() - started > STUCK_AFTER_MS);
      } catch {
        // A missed poll just tries again next tick.
      }
    };
    const pollLive = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/live`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { calls: LiveToolCall[]; currentTaskId: string | null };
        if (cancelled) return;
        setLiveTaskId(data.currentTaskId ?? null);
        setLiveCalls(data.calls ?? []);
      } catch {
        // Best-effort.
      }
    };

    void pollLive();
    const runTimer = setInterval(pollRun, RUN_POLL_MS);
    const liveTimer = setInterval(pollLive, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(runTimer);
      clearInterval(liveTimer);
    };
  }, [active, busy, runId]);

  async function loadDetail(id: string) {
    const res = await fetch(`/api/runs/${id}`);
    if (!res.ok) throw new Error(`Could not load run ${id} (HTTP ${res.status}).`);
    setDetail((await res.json()) as RunDetail);
  }

  async function start(text = brief) {
    const request = text.trim();
    if (!request || active) return;
    setBrief(request);
    setError(null);
    setStuck(false);
    setLiveTaskId(null);
    setLiveCalls([]);
    try {
      const fields = developer && workfrontProjectId.trim() ? { workfront_project_id: workfrontProjectId.trim() } : undefined;
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          async: true,
          input: { brief: request, ...(fields ? { fields } : {}), ...(runMode === "demo" ? { mode: "demo" } : {}) },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.run) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setDetail({ run: data.run, taskRuns: [] });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** Answer / approve / retry: one request that returns when the pipeline pauses or ends. */
  async function act(path: string, body?: unknown) {
    if (!runId) return;
    setBusy(true);
    setError(null);
    setStuck(false);
    try {
      const res = await fetch(`/api/runs/${runId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      await loadDetail(runId);
    } catch (err) {
      setError((err as Error).message);
      await loadDetail(runId).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function reset(keepBrief = false) {
    setDetail(null);
    setError(null);
    setStuck(false);
    setLiveTaskId(null);
    setLiveCalls([]);
    if (!keepBrief) setBrief("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // While a request is in flight the run row can still say "needs_input" or
  // "awaiting_approval" from before it - show progress, not the old prompt.
  const outcome: Outcome | null = detail
    ? busy
      ? { kind: "working", stage: currentStage(detail.taskRuns, liveTaskId) }
      : outcomeOf(detail, liveTaskId)
    : null;
  const finished = outcome && ["success", "defined", "not_built", "failed"].includes(outcome.kind);

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <div className="ambient" aria-hidden />

      <header className="sticky top-0 z-20 px-4 pt-4 sm:px-6">
        <nav className="glass mx-auto flex max-w-5xl items-center gap-3 rounded-full px-4 py-2.5 sm:px-5">
          <button onClick={() => reset()} className="flex items-center gap-2 text-label" aria-label="Audience Studio home">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white">
              <PeopleIcon className="h-4 w-4" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">Audience Studio</span>
          </button>
          {developer && (
            <div className="ml-2 hidden items-center gap-4 text-[13px] text-label-secondary sm:flex">
              {[
                ["/runs", "Runs"],
                ["/evals", "Evals"],
                ["/agents", "Agents"],
                ["/settings", "Settings"],
              ].map(([href, label]) => (
                <Link key={href} href={href} className="hover:text-label">
                  {label}
                </Link>
              ))}
            </div>
          )}
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-[13px] text-label-secondary">
            <span className="hidden sm:inline">Developer</span>
            <span className="sr-only sm:hidden">Developer mode</span>
            <button
              role="switch"
              aria-checked={developer}
              onClick={() => setDeveloper(!developer)}
              className={`relative h-[22px] w-[38px] rounded-full transition-colors duration-200 ${
                developer ? "bg-success" : "bg-label-tertiary/40"
              }`}
            >
              <span
                className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-transform duration-200 ${
                  developer ? "translate-x-[18px]" : "translate-x-[2px]"
                }`}
              />
            </button>
          </label>
        </nav>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-3xl flex-col px-4 pb-24 sm:px-6">
        {!detail ? (
          <section className="rise flex flex-col items-center pt-[12vh] text-center sm:pt-[16vh]">
            <p className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
              <SparkleIcon className="h-4 w-4" /> Comcast Business audiences, built in Adobe Experience Platform
            </p>
            <h1 className="text-[40px] font-semibold leading-[1.08] tracking-tight text-label sm:text-[56px]">
              What audience
              <br />
              do you need?
            </h1>
            <p className="mt-4 max-w-md text-[17px] leading-relaxed text-label-secondary">
              Describe it the way you&apos;d say it. We&apos;ll find the right customer data and build it for you.
            </p>

            <Composer
              value={brief}
              onChange={setBrief}
              onSubmit={() => start()}
              inputRef={inputRef}
              disabled={active}
            />

            {developer && (
              <DeveloperOptions
                mode={mode}
                onMode={setMode}
                workfrontProjectId={workfrontProjectId}
                onWorkfrontProjectId={setWorkfrontProjectId}
              />
            )}

            <div className="mt-8 flex max-w-2xl flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => start(s)}
                  className="glass rounded-full px-4 py-2 text-left text-[14px] text-label-secondary transition hover:text-label active:scale-[0.98]"
                >
                  {s}
                </button>
              ))}
            </div>
            {error && <ErrorNote developer={developer} error={error} />}
          </section>
        ) : (
          <section className="flex flex-col gap-5 pt-10 sm:pt-14" aria-live="polite">
            <div className="rise flex justify-end">
              <p className="max-w-[85%] rounded-[22px] rounded-br-md bg-accent px-4 py-2.5 text-[16px] leading-snug text-white shadow-lg shadow-accent/20">
                {(detail.run.input as { brief?: string })?.brief ?? brief}
              </p>
            </div>

            {outcome?.kind === "working" && <WorkingCard stage={outcome.stage} stuck={stuck} onRetry={() => act("retry")} />}
            {outcome?.kind === "question" && (
              <QuestionCard
                key={detail.taskRuns.length}
                questions={outcome.questions}
                busy={busy}
                onSubmit={(answers) => act("resume", { answers })}
              />
            )}
            {outcome?.kind === "approval" && <ApprovalCard next={outcome.next} busy={busy} onApprove={() => act("continue")} />}
            {outcome?.kind === "success" && <SuccessCard audience={outcome.audience} developer={developer} />}
            {outcome?.kind === "defined" && (
              <NoticeCard
                tone="info"
                title="Audience defined"
                body={outcome.interpretation ?? "The audience's definition was written and verified."}
                note={outcome.note}
                rule={developer ? outcome.rule : null}
              />
            )}
            {outcome?.kind === "not_built" && (
              <NoticeCard tone="warning" title="We couldn't build this one" body={outcome.reason} />
            )}
            {outcome?.kind === "failed" && <NoticeCard tone="warning" title="Something went wrong" body={outcome.reason} />}

            {error && <ErrorNote developer={developer} error={error} />}

            {finished && (
              <div className="rise flex flex-wrap justify-center gap-3 pt-2">
                <button
                  onClick={() => reset()}
                  className="rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-white shadow-lg shadow-accent/25 transition hover:bg-accent-hover active:scale-[0.98]"
                >
                  New audience
                </button>
                {outcome && outcome.kind !== "success" && (
                  <button
                    onClick={() => reset(true)}
                    className="glass rounded-full px-6 py-3 text-[15px] font-medium text-label transition active:scale-[0.98]"
                  >
                    Edit request
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {developer && (
          <DeveloperPanel detail={detail} liveCalls={liveCalls} liveTaskId={liveTaskId} active={active} error={error} />
        )}
      </main>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  inputRef,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
}) {
  // Grow with the text, up to a few lines, like Messages.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value, inputRef]);

  return (
    <form
      className="glass glass-strong mt-10 flex w-full max-w-2xl items-end gap-2 rounded-[30px] p-2 pl-5 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="brief" className="sr-only">
        Describe the audience
      </label>
      <textarea
        id="brief"
        ref={inputRef}
        rows={1}
        autoFocus
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="e.g. CB Internet customers eligible for Security Edge Preferred"
        className="max-h-[180px] min-h-[44px] flex-1 resize-none bg-transparent py-[11px] text-[17px] leading-snug text-label outline-none placeholder:text-label-tertiary"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        aria-label="Build audience"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent-hover active:scale-95 disabled:bg-label-tertiary/30 disabled:text-white/80"
      >
        <ArrowUpIcon className="h-5 w-5" />
      </button>
    </form>
  );
}

function DeveloperOptions({
  mode,
  onMode,
  workfrontProjectId,
  onWorkfrontProjectId,
}: {
  mode: "demo" | "governed";
  onMode: (m: "demo" | "governed") => void;
  workfrontProjectId: string;
  onWorkfrontProjectId: (v: string) => void;
}) {
  return (
    <div className="rise mt-4 flex w-full max-w-2xl flex-col items-center gap-3 sm:flex-row sm:justify-center">
      <div className="glass inline-flex rounded-full p-1" role="radiogroup" aria-label="Run mode">
        {(["demo", "governed"] as const).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={mode === m}
            onClick={() => onMode(m)}
            className={`rounded-full px-4 py-1.5 text-[13px] font-medium transition ${
              mode === m ? "bg-background text-label shadow-sm" : "text-label-secondary hover:text-label"
            }`}
          >
            {m === "demo" ? "Demo" : "Governed"}
          </button>
        ))}
      </div>
      {mode === "governed" && (
        <input
          value={workfrontProjectId}
          onChange={(e) => onWorkfrontProjectId(e.target.value)}
          placeholder="Workfront project ID (optional)"
          className="glass w-full rounded-full px-4 py-2 text-[13px] text-label outline-none placeholder:text-label-tertiary sm:w-64"
        />
      )}
    </div>
  );
}

function WorkingCard({ stage, stuck, onRetry }: { stage: number; stuck: boolean; onRetry: () => void }) {
  return (
    <div className="glass rise rounded-[28px] p-6 sm:p-7">
      <ol className="flex flex-col gap-4">
        {STAGES.map((label, i) => {
          const state = i < stage ? "done" : i === stage ? "active" : "todo";
          return (
            <li key={label} className="flex items-center gap-3.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                {state === "done" ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success text-white">
                    <CheckIcon className="h-3.5 w-3.5" />
                  </span>
                ) : state === "active" ? (
                  <Spinner className="h-6 w-6 text-accent" />
                ) : (
                  <span className="h-5 w-5 rounded-full border-2 border-label-tertiary/40" />
                )}
              </span>
              <span
                className={`text-[17px] transition-colors ${
                  state === "active" ? "font-medium text-label" : state === "done" ? "text-label-secondary" : "text-label-tertiary"
                }`}
              >
                {label}
                {state === "active" && "…"}
              </span>
            </li>
          );
        })}
      </ol>
      {stuck ? (
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-separator pt-4">
          <p className="text-[14px] text-label-secondary">This is taking longer than usual.</p>
          <button onClick={onRetry} className="rounded-full bg-accent px-4 py-1.5 text-[14px] font-medium text-white">
            Try again
          </button>
        </div>
      ) : (
        <p className="mt-5 text-[13px] text-label-tertiary">Usually ready in under a minute.</p>
      )}
    </div>
  );
}

function QuestionCard({
  questions,
  busy,
  onSubmit,
}: {
  questions: PendingQuestion[];
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const ready = questions.every((q) => (answers[q.key] ?? "").trim());
  // "No field matches X" questions (buildability.ts) can always be answered by leaving X out.
  const canDrop = questions.length === 1 && questions[0].key.startsWith("filter:");

  return (
    <form
      className="glass rise rounded-[28px] p-6 sm:p-7"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onSubmit(answers);
      }}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-accent">
          <QuestionIcon className="h-5 w-5" />
        </span>
        <h2 className="text-[20px] font-semibold tracking-tight text-label">One quick question</h2>
      </div>
      <div className="mt-4 flex flex-col gap-4">
        {questions.map((q) => (
          <label key={q.key} className="flex flex-col gap-2">
            <span className="text-[16px] leading-relaxed text-label-secondary">{q.ask ?? q.label}</span>
            {q.options?.length ? (
              <select
                value={answers[q.key] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                className="rounded-2xl border border-separator bg-background/70 px-4 py-3 text-[16px] text-label outline-none focus:border-accent"
              >
                <option value="" disabled>
                  Choose…
                </option>
                {q.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                autoFocus
                value={answers[q.key] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                placeholder="Your answer"
                className="rounded-2xl border border-separator bg-background/70 px-4 py-3 text-[16px] text-label outline-none placeholder:text-label-tertiary focus:border-accent"
              />
            )}
          </label>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!ready || busy}
          className="rounded-full bg-accent px-5 py-2.5 text-[15px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
        >
          Continue
        </button>
        {canDrop && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSubmit({ [questions[0].key]: "Drop this condition" })}
            className="rounded-full px-5 py-2.5 text-[15px] font-medium text-accent transition hover:bg-accent/10 disabled:opacity-40"
          >
            Leave it out
          </button>
        )}
      </div>
    </form>
  );
}

function ApprovalCard({ next, busy, onApprove }: { next: string; busy: boolean; onApprove: () => void }) {
  return (
    <div className="glass rise flex flex-wrap items-center justify-between gap-4 rounded-[28px] p-6 sm:p-7">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight text-label">Ready for your go-ahead</h2>
        <p className="mt-1 text-[15px] text-label-secondary">Next: {next.toLowerCase()}.</p>
      </div>
      <button
        onClick={onApprove}
        disabled={busy}
        className="rounded-full bg-accent px-5 py-2.5 text-[15px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40"
      >
        Approve
      </button>
    </div>
  );
}

/** Follow AEP's count while it is still being made; otherwise the summary's own size. */
function useSize(audience: AudienceSummary): AudienceSummary["size"] {
  const [size, setSize] = useState(audience.size);
  const pending = audience.pending;
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const qs = new URLSearchParams({
      jobId: pending.jobId,
      segmentId: pending.segmentId,
      ...(pending.sandbox ? { sandbox: pending.sandbox } : {}),
    });
    const tick = async () => {
      try {
        const res = await fetch(`/api/audience-size?${qs}`);
        if (!res.ok || stopped) return;
        const estimate = (await res.json()) as SegmentSizeEstimate;
        setSize(friendlySize(estimate));
        if (estimate.available || !estimate.pending) stopped = true;
      } catch {
        // Try again next tick.
      }
    };
    const timer = setInterval(() => (stopped ? clearInterval(timer) : void tick()), 15_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pending]);
  return size;
}

function SuccessCard({ audience, developer }: { audience: AudienceSummary; developer: boolean }) {
  const size = useSize(audience);
  const [copied, setCopied] = useState(false);
  const built = new Date(audience.builtAt);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(audience.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable - the ID is still on screen to select.
    }
  }

  return (
    <article className="glass glass-strong rise rounded-[32px] p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success text-white shadow-lg shadow-success/30">
          <CheckIcon draw className="h-5 w-5" />
        </span>
        <p className="text-[15px] font-semibold text-success">
          {audience.reused ? "Audience ready" : "Audience created"}
        </p>
        {audience.demo && (
          <span className="ml-auto rounded-full bg-warning-fill px-2.5 py-1 text-[12px] font-semibold text-warning">
            Demo
          </span>
        )}
      </div>

      <h2 className="mt-5 text-[30px] font-semibold leading-tight tracking-tight text-label sm:text-[36px]">
        {audience.displayName}
      </h2>
      {audience.interpretation && (
        <p className="mt-3 text-[17px] leading-relaxed text-label-secondary">{audience.interpretation}</p>
      )}

      <dl className="mt-7 grid grid-cols-1 gap-x-8 gap-y-5 border-t border-separator pt-6 sm:grid-cols-2">
        <Detail label="Status">
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-success" />
            {audience.reused ? "Already live, reused" : "Live in Adobe Experience Platform"}
          </span>
        </Detail>
        <Detail label="Audience size">
          <span className={size.counted ? "font-semibold text-label" : undefined}>{size.text}</span>
        </Detail>
        <Detail label="Environment">{audience.environment}</Detail>
        <Detail label="Built">
          {built.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </Detail>
        <Detail label="Name in Adobe Experience Platform" wide>
          {audience.aepName}
        </Detail>
        <Detail label="Audience ID" wide>
          <span className="inline-flex items-center gap-2">
            <span className="font-mono text-[14px]">{audience.id}</span>
            <button
              onClick={copyId}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium text-accent hover:bg-accent/10"
              aria-label="Copy audience ID"
            >
              <CopyIcon className="h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        </Detail>
        {developer && audience.rule && (
          <Detail label="Rule (PQL)" wide>
            <span className="break-all font-mono text-[13px]">{audience.rule}</span>
          </Detail>
        )}
      </dl>
    </article>
  );
}

function Detail({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-[12px] font-medium uppercase tracking-wide text-label-tertiary">{label}</dt>
      <dd className="mt-1 text-[15px] text-label-secondary">{children}</dd>
    </div>
  );
}

function NoticeCard({
  tone,
  title,
  body,
  note,
  rule,
}: {
  tone: "info" | "warning";
  title: string;
  body: string;
  note?: string;
  rule?: string | null;
}) {
  return (
    <div className="glass rise rounded-[28px] p-6 sm:p-7">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-full ${
            tone === "info" ? "bg-accent/15 text-accent" : "bg-warning-fill text-warning"
          }`}
        >
          {tone === "info" ? <InfoIcon className="h-5 w-5" /> : <ExclamationIcon className="h-5 w-5" />}
        </span>
        <h2 className="text-[20px] font-semibold tracking-tight text-label">{title}</h2>
      </div>
      <p className="mt-3 text-[16px] leading-relaxed text-label-secondary">{body}</p>
      {note && <p className="mt-2 text-[14px] text-label-tertiary">{note}</p>}
      {rule && <p className="mt-3 break-all font-mono text-[13px] text-label-secondary">{rule}</p>}
    </div>
  );
}

function ErrorNote({ developer, error }: { developer: boolean; error: string }) {
  return (
    <p className="rise mt-6 text-center text-[15px] text-label-secondary">
      That didn&apos;t go through. Please try again.
      {developer && <span className="mt-1 block font-mono text-[12px] text-danger">{error}</span>}
    </p>
  );
}
