"use client";
import { Fragment, memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ClaudeLogo, OpenAILogo } from "./logos";
import type {
  Actor,
  Call,
  DocumentVersion,
  Intervention,
  ModelChoices,
  Project,
  Stage,
} from "@/lib/types";

export type ModelDefaults = Record<Actor, { model: string; effort: string }>;

export const stageLabels: Record<string, string> = {
  plan: "질문 분해",
  draft: "각자 초안",
  merge: "초안 합치기",
  revise: "공동 문서 수정",
  explore: "탐색 릴레이",
  research: "독립 조사",
  critique: "상호비판",
  rebuttal: "반박 · 수정",
  contradictions: "모순 확인",
  synthesis: "최종 종합",
  "report-edit": "보고서 결론 다듬기",
  conversation: "후속 대화",
  "conversation-synthesis": "공동 정리",
};
const stageHints: Record<string, string> = {
  plan: "GPT가 주제를 연구 질문으로 나눕니다.",
  draft: "서로의 글을 보지 않고 각자 전체 초안을 씁니다.",
  merge: "두 초안을 하나로 합치고, 갈리는 부분은 ⚖️ 쟁점으로 남깁니다.",
  revise: "상대가 고친 최신 문서를 이어받아 근거와 함께 수정합니다.",
  explore: "앞 차례 결과에서 맞지 않는 자료는 빼고, 빈틈을 채우고, 유망한 흐름을 더 파고듭니다.",
  research: "서로의 답을 보지 않고 각자 조사합니다.",
  critique: "상대의 주장에서 약한 근거와 빈틈을 찾습니다.",
  rebuttal: "받은 비판에 답하고 주장을 고치거나 거둡니다.",
  contradictions: "원문을 확인한 주장들 가운데 동시에 참일 수 없는 쌍을 찾아요.",
  synthesis: "원장과 남은 질문을 모아 보고서를 씁니다.",
  "report-edit": "다른 모델이 결론이 앞에 오도록 보고서를 한 번 더 다듬어요.",
};

// Markdown parsing is the heaviest render work; skip it when the text is unchanged.
export const SafeMarkdown = memo(function SafeMarkdown({
  children,
  className = "md",
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: () => null,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
});

// Browser-only conveniences (drafts, last view). Research records themselves are
// saved on the server in data/<id>.json; storage may be unavailable.
export function loadLocal<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(`ourtoy:${key}`);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}
export function saveLocal(key: string, value: unknown) {
  try {
    if (value === undefined || value === "") localStorage.removeItem(`ourtoy:${key}`);
    else localStorage.setItem(`ourtoy:${key}`, JSON.stringify(value));
  } catch {}
}

/** Re-render every second while something is running. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** "42s", "18m 26s", "1h 03m" */
export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    sec = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function Elapsed({
  start,
  end,
  running,
}: {
  start?: string;
  end?: string;
  running?: boolean;
}) {
  const now = useNow(Boolean(running));
  if (!start) return null;
  const to = end && !running ? Date.parse(end) : now;
  return (
    <span className={`elapsed ${running ? "live" : ""}`} title={running ? "경과 시간" : "걸린 시간"}>
      {running && <i aria-hidden>●</i>}({formatElapsed(to - Date.parse(start))})
    </span>
  );
}

/** Copies text and briefly confirms. */
export function CopyButton({ text, label = "복사" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copyButton"
      aria-label={`${label}하기`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {}
      }}
    >
      {done ? "복사했어요" : label}
    </button>
  );
}

/** <details> that renders its (often large) body only once opened. */
export function LazyDetails({
  summary,
  className = "restDetails",
  children,
}: {
  summary: React.ReactNode;
  className?: string;
  children: () => React.ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details className={className} onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary>{summary}</summary>
      {opened && children()}
    </details>
  );
}

const noteTargets = (note: Intervention): Actor[] =>
  note.target === "both" ? ["GPT", "Claude"] : [note.target];

/** Mirrors lib/interventions isPendingNote (that module uses fs). */
export function notePending(note: Intervention) {
  if (note.expired) return false;
  const got = note.deliveries ? note.deliveries.map((d) => d.actor) : note.appliedAt ? noteTargets(note) : [];
  return noteTargets(note).some((a) => !got.includes(a));
}

/** "9/14 13:05:12" — same day shows only the time. */
export function formatStamp(iso?: string, now = Date.now()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** Machine-readable timestamp with the full date on hover. */
export function Stamp({ at, label }: { at?: string; label?: string }) {
  if (!at) return null;
  const full = new Date(at).toLocaleString("ko-KR", { hour12: false });
  return (
    <time className="stamp" dateTime={at} title={label ? `${label} ${full}` : full}>
      {label && `${label} `}
      {formatStamp(at)}
    </time>
  );
}

/** Split out the "핵심 요점" section the prompts ask every answer to start with. */
export function splitKeyPoints(md: string) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) =>
    /^#{1,6}\s*(핵심\s*요점|요점|TL;?DR)/i.test(l.trim()),
  );
  if (start < 0) return { key: "", rest: md };
  let end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l.trim()));
  if (end < 0) end = lines.length;
  return {
    key: lines.slice(start + 1, end).join("\n").trim(),
    rest: [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim(),
  };
}

export const RichMarkdown = memo(function RichMarkdown({ children }: { children: string }) {
  const { key, rest } = splitKeyPoints(children);
  return (
    <>
      {key && (
        <div className="keyPoints">
          <span className="keyLabel">핵심 요점</span>
          <SafeMarkdown>{key}</SafeMarkdown>
        </div>
      )}
      {rest && <SafeMarkdown>{rest}</SafeMarkdown>}
    </>
  );
});

/** Plain one-line title from a Markdown topic. */
export function firstLine(md: string) {
  const line = md.split("\n").find((l) => l.trim()) ?? md;
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/(\*\*|__|`|~~)/g, "")
    .trim();
}

type FieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  minLength?: number;
  required?: boolean;
  disabled?: boolean;
  compact?: boolean;
  /** Keep the label for screen readers only, when the screen title already says it. */
  hideLabel?: boolean;
  onSubmitShortcut?: () => void;
};

/** Grows with its content up to this height, then scrolls. */
const FIELD_MAX_PX = 320;
const COMPACT_MAX_PX = 220;

// Markdown is accepted as typed and rendered later; the box itself stays a plain,
// self-sizing text area with no formatting chrome.
export function MarkdownField(props: FieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, props.compact ? COMPACT_MAX_PX : FIELD_MAX_PX)}px`;
  }, [props.value, props.compact]);
  return (
    <div className={`mdField ${props.compact ? "compact" : ""}`}>
      <label htmlFor={props.id} className={props.hideLabel ? "srOnly" : "mdLabel"}>
        {props.label}
      </label>
      {props.maxLength && props.value.length > props.maxLength * 0.6 && (
        <span className={`fieldCount ${props.value.length > props.maxLength * 0.95 ? "near" : ""}`}>
          {props.value.length.toLocaleString()} / {props.maxLength.toLocaleString()}자
        </span>
      )}
      <textarea
        ref={ref}
        id={props.id}
        rows={props.compact ? 1 : 3}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (props.onSubmitShortcut && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            props.onSubmitShortcut();
          }
        }}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        minLength={props.minLength}
        required={props.required}
        disabled={props.disabled}
      />
    </div>
  );
}

const presets: Record<Actor, string[]> = {
  GPT: ["gpt-5.6-sol", "gpt-6-astra"],
  Claude: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"],
};
const effortOptions: Record<Actor, string[]> = {
  GPT: ["low", "medium", "high", "xhigh"],
  Claude: ["low", "medium", "high", "xhigh", "max"],
};

export function ModelPicker({
  value,
  onChange,
  defaults,
  disabled,
}: {
  value: ModelChoices;
  onChange: (value: ModelChoices) => void;
  defaults?: ModelDefaults;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState<Partial<Record<Actor, boolean>>>({});
  return (
    <div className="modelPicker">
      {(["GPT", "Claude"] as const).map((actor) => {
        const choice = value[actor] ?? {};
        const isCustom =
          custom[actor] || Boolean(choice.model && !presets[actor].includes(choice.model));
        const set = (patch: { model?: string; effort?: string }) =>
          onChange({ ...value, [actor]: { ...choice, ...patch } } as ModelChoices);
        return (
          <div className="modelRow" key={actor}>
            <span className={`avatar brandLogo ${actor.toLowerCase()}`}>{actor === "GPT" ? <OpenAILogo size={16} /> : <ClaudeLogo size={16} />}</span>
            <label>
              {actor} 모델
              <select
                value={isCustom ? "__custom" : (choice.model ?? "")}
                disabled={disabled}
                onChange={(e) => {
                  const picked = e.target.value;
                  setCustom((c) => ({ ...c, [actor]: picked === "__custom" }));
                  set({ model: picked === "__custom" ? choice.model : picked || undefined });
                }}
              >
                <option value="">기본값 · {defaults?.[actor].model ?? ".env"}</option>
                {presets[actor].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom">직접 입력…</option>
              </select>
            </label>
            {isCustom && (
              <label>
                모델 ID
                <input
                  value={choice.model ?? ""}
                  disabled={disabled}
                  maxLength={80}
                  placeholder={actor === "GPT" ? "gpt-…" : "claude-…"}
                  onChange={(e) => set({ model: e.target.value || undefined })}
                />
              </label>
            )}
            <label>
              추론 강도
              <select
                value={choice.effort ?? ""}
                disabled={disabled}
                onChange={(e) => set({ effort: e.target.value || undefined })}
              >
                <option value="">기본값 · {defaults?.[actor].effort ?? ".env"}</option>
                {effortOptions[actor].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            {(choice.effort === "max" || choice.effort === "xhigh") && (
              <p className="help effortNote">
                {choice.effort}는 단계당 10~30분 걸릴 수 있어요. 수정·탐색·후속 대화는 자동으로 high로
                제한하고, 너무 오래 걸리면 강도를 낮춰 다시 요청해요.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Drop empty picks so the server falls back to .env defaults. */
export function cleanModels(value: ModelChoices): ModelChoices | undefined {
  const out: ModelChoices = {};
  for (const actor of ["GPT", "Claude"] as const) {
    const c = value[actor];
    const model = c?.model?.trim();
    if (model || c?.effort)
      out[actor] = { ...(model ? { model } : {}), ...(c?.effort ? { effort: c.effort } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

export function ModelChips({
  project,
  defaults,
}: {
  project: Project;
  defaults?: ModelDefaults;
}) {
  if (project.mode === "mock") return null;
  return (
    <div className="modelChips">
      {(["GPT", "Claude"] as const).map((actor) => {
        const model = project.models?.[actor]?.model ?? defaults?.[actor].model;
        const effort = project.models?.[actor]?.effort ?? defaults?.[actor].effort;
        return (
          <span key={actor} className={`modelChip ${actor.toLowerCase()}`}>
            <b>{actor}</b> {model ?? "기본값"}
            {effort && <em>{effort}</em>}
          </span>
        );
      })}
    </div>
  );
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span className={`confChip ${pct >= 70 ? "high" : pct >= 40 ? "mid" : "low"}`}>
      확신 {pct}%
    </span>
  );
}

// Finished calls never change, so a bubble re-renders only when its call moves.
const Bubble = memo(BubbleView, (a, b) =>
  a.actor === b.actor &&
  a.skipped === b.skipped &&
  a.call?.progress?.lastAt === b.call?.progress?.lastAt &&
  a.call?.status === b.call?.status &&
  a.call?.startedAt === b.call?.startedAt &&
  a.call?.finishedAt === b.call?.finishedAt &&
  a.call?.replayed === b.call?.replayed &&
  a.call?.error === b.call?.error,
);

/** "검색 3회 · 마지막 응답 2분 전"; a quiet stretch is normal thinking, not an error. */
function CallProgressLine({ progress }: { progress?: Call["progress"] }) {
  const now = useNow(true);
  if (!progress) return <p className="progressLine">응답을 기다리고 있어요</p>;
  const idleMin = Math.max(0, Math.floor((now - Date.parse(progress.lastAt)) / 60000));
  return (
    <p className="progressLine">
      {progress.searches > 0 && `검색 ${progress.searches}회 · `}
      {idleMin >= 5
        ? `생각 중이에요 · 마지막 응답 ${idleMin}분 전`
        : idleMin > 0
          ? `마지막 응답 ${idleMin}분 전`
          : "방금 응답했어요"}
    </p>
  );
}

function BubbleView({
  call,
  actor,
  onOpenReport,
  skipped,
}: {
  call?: Call;
  actor: Actor;
  onOpenReport?: () => void;
  /** The engine skipped this stalled turn and kept going. */
  skipped?: boolean;
}) {
  const cls = `bubble ${actor.toLowerCase()}`;
  if (!call)
    return (
      <div className={`${cls} ghost`}>
        <span className="help">호출 없음</span>
      </div>
    );
  const a = call.result?.answer;
  const { key, rest } = splitKeyPoints(a?.summary ?? "");
  const structured = Boolean(key || a?.claims.length || a?.critiques.length);
  const editing = call.stage === "merge" || call.stage === "revise";
  const isReply = (claim: string) => /^\s*응답:/.test(claim);
  const replies = (a?.critiques ?? []).filter((c) => isReply(c.claim));
  const edits = (a?.critiques ?? []).filter((c) => !isReply(c.claim));
  const writesDocument = editing || call.stage === "draft";
  return (
    <article className={cls}>
      <div className="bubbleHead">
        <span className={`avatar brandLogo ${actor.toLowerCase()}`}>{actor === "GPT" ? <OpenAILogo size={16} /> : <ClaudeLogo size={16} />}</span>
        <span>
          <b>{actor}</b>
          <small>
            {call.result?.model ?? (call.status === "running" ? "응답 중" : "")}
            {" · "}
            <Stamp at={call.startedAt} label="요청" />
            {call.finishedAt && (
              <>
                {" → "}
                <Stamp at={call.finishedAt} label="완료" />
              </>
            )}
          </small>
        </span>
        <span className={`callStatus ${skipped && call.status === "failed" ? "skipped" : call.status}`}>
          {call.status === "running"
            ? "작성 중"
            : call.status === "failed"
              ? skipped
                ? "건너뜀"
                : "실패"
              : call.replayed
                ? "저장본 재생"
                : "완료"}{" "}
          <Elapsed start={call.startedAt} end={call.finishedAt} running={call.status === "running"} />
        </span>
      </div>
      {call.status === "running" && (
        <div className="runningInfo" role="status" aria-label={`${actor} 응답 작성 중`}>
          <div className="typing" aria-hidden>
            <i />
            <i />
            <i />
          </div>
          <CallProgressLine progress={call.progress} />
        </div>
      )}
      {call.error &&
        (skipped ? (
          <p className="skippedNote">
            {/^.*한도/.test(call.error)
              ? "사용량 한도라 이번 차례는 건너뛰었어요 · 한도가 풀린 뒤 이어서 실행하면 다시 해요"
              : "응답이 없어 이번 차례는 건너뛰었어요 · 이어서 실행하면 다시 시도해요"}
          </p>
        ) : (
          <p className="error">{call.error}</p>
        ))}
      {a && (
        <>
          {a.questions.length > 0 && call.stage !== "explore" && (
            <ol className="pointList">
              {a.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          )}
          {key && !editing && (
            <div className="keyPoints">
              <span className="keyLabel">핵심 요점</span>
              <SafeMarkdown>{key}</SafeMarkdown>
            </div>
          )}
          {editing && replies.length > 0 && (
            <div className="changeList replyList">
              <b>상대 변경에 대한 답</b>
              <ul>
                {replies.map((c, i) => (
                  <li key={i}>
                    <span>{c.claim.replace(/^\s*응답:\s*/, "")}</span>
                    <p>{c.objection}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {a.claims.length > 0 && (
            <ul className="claimList" aria-label="주장">
              {a.claims.map((c, i) => (
                <li key={i}>
                  <p>{c.statement}</p>
                  <span className="claimFoot">
                    <Confidence value={c.confidence} />
                    <small>근거 {c.sources.length}개</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {call.stage === "explore" &&
            (a.critiques.length ? (
              <div className="changeList exclusions">
                <b>제외한 자료 {a.critiques.length}건</b>
                <ul>
                  {a.critiques.map((c, i) => (
                    <li key={i}>
                      <span>{c.claim}</span>
                      <p>{c.objection}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="help">앞 차례 자료는 모두 유지했어요.</p>
            ))}
          {call.stage === "explore" && (
            <div className="threadList">
              <b>다음 탐색 흐름</b>
              {a.questions.length ? (
                <ul>
                  {a.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              ) : (
                <p className="help">더 파고들 흐름이 없다고 판단했어요.</p>
              )}
            </div>
          )}
          {editing && (
            <div className="changeList">
              <b>{call.stage === "merge" ? "합치면서 정한 것" : "이번 차례 변경 사항"}</b>
              {edits.length ? (
                <ul>
                  {edits.map((c, i) => (
                    <li key={i}>
                      <span>{c.claim}</span>
                      <p>{c.objection}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="help">더 고칠 부분이 없다고 판단했습니다.</p>
              )}
            </div>
          )}
          {!editing && call.stage !== "explore" && a.critiques.length > 0 && (
            <ul className="critiqueList" aria-label="비판">
              {a.critiques.map((c, i) => (
                <li key={i}>
                  <q>{c.claim}</q>
                  <p>
                    <b>반론</b> {c.objection}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {rest &&
            (call.stage === "synthesis" ? (
              <button type="button" className="secondary" onClick={onOpenReport}>
                최종 보고서 탭에서 보기 →
              </button>
            ) : structured ? (
              <LazyDetails summary={writesDocument ? "이 버전 문서 전체 보기" : "전체 설명 보기"}>
                {() => <SafeMarkdown>{rest}</SafeMarkdown>}
              </LazyDetails>
            ) : (
              <SafeMarkdown>{rest}</SafeMarkdown>
            ))}
          {a.unresolved.length > 0 && (
            <details className="restDetails">
              <summary>남은 질문 {a.unresolved.length}개</summary>
              <ul>
                {a.unresolved.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </article>
  );
}

function HumanNote({ note }: { note: Intervention }) {
  const pending = notePending(note);
  const deliveries =
    note.deliveries ??
    (note.appliedAt && note.appliedStage
      ? noteTargets(note).map((actor) => ({
          actor,
          stage: note.appliedStage!,
          round: note.appliedRound ?? 0,
          at: note.appliedAt!,
        }))
      : []);
  return (
    <div className={`humanNote ${pending ? "pending" : ""} ${note.expired ? "expired" : ""}`}>
      <div className="noteHead">
        <span className="avatar human" aria-hidden>
          나
        </span>
        <span>
          <b>사람 개입</b>
          <small>
            {note.target === "both" ? "GPT + Claude" : `${note.target}에게`} ·{" "}
            <Stamp at={note.createdAt} label="보냄" />
          </small>
          <small className="deliveries">
            {deliveries.map((d) => (
              <span key={`${d.actor}-${d.stage}-${d.round}`} className="delivered">
                {d.actor}에게 전달 · {stageLabels[d.stage]}
                {d.round ? ` R${d.round}` : ""} <Stamp at={d.at} />
              </span>
            ))}
            {note.expired
              ? noteTargets(note)
                  .filter((a) => !deliveries.some((d) => d.actor === a))
                  .map((a) => (
                    <span key={a} className="missed">
                      {a}에게는 연구가 끝나 전달하지 못했어요
                    </span>
                  ))
              : pending && <span>해당 모델의 다음 차례에 전달할게요</span>}
          </small>
        </span>
      </div>
      <SafeMarkdown>{note.text}</SafeMarkdown>
    </div>
  );
}

const debateStages: Stage[] = ["research", "critique", "rebuttal"];

function QuestionBubble({ project }: { project: Project }) {
  const files = project.attachments?.length ?? 0;
  return (
    <div className="questionBubble">
      <div className="chatMessage userBubble">
        <small>
          내 질문 · <Stamp at={project.createdAt} label="요청" />
          {(project.referenceText || files > 0) &&
            ` · 참고 자료 ${project.referenceText ? "텍스트" : ""}${project.referenceText && files ? " + " : ""}${files ? `파일 ${files}개` : ""}`}
        </small>
        <RichMarkdown>{project.topic}</RichMarkdown>
      </div>
    </div>
  );
}

export function DebateThread({
  project,
  onOpenReport,
}: {
  project: Project;
  onOpenReport: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const codraft = project.strategy === "codraft";
  const relay = project.strategy === "relay";
  const calls = project.calls.filter((c) => c.stage in stageHints);
  const notes = project.interventions ?? [];
  const pending = notes.filter((n) => notePending(n) && !n.appliedAt);
  const planCall = calls.find((c) => c.stage === "plan");
  const synthesisCall = calls.find((c) => c.stage === "synthesis");
  const editCall = calls.find((c) => c.stage === "report-edit");
  const chips = [
    ["all", "전체"],
    ...(planCall ? [["plan", "준비"]] : []),
    ...project.rounds.map((r) => [`r${r.number}`, `라운드 ${r.number}`]),
    ...(synthesisCall || editCall ? [["synthesis", "종합"]] : []),
  ];
  const show = (key: string) => filter === "all" || filter === key;
  const pick = (stage: Stage, round: number, actor: Actor) =>
    [...calls].reverse().find((c) => c.stage === stage && c.round === round && c.actor === actor);
  const notesAt = (stage: Stage, round: number) =>
    notes
      .filter((n) => n.appliedStage === stage && n.appliedRound === round)
      .map((n) => <HumanNote key={n.id} note={n} />);
  const head = (stage: Stage) => (
    <div className="stageHead">
      <b>{stageLabels[stage]}</b>
      <span>{stageHints[stage]}</span>
    </div>
  );

  // A stalled turn the engine skipped reads as neutral unless the whole run failed.
  const wasSkipped = (round: number, actor: Actor) =>
    project.status !== "failed" &&
    Boolean(project.rounds.find((r) => r.number === round)?.skipped?.includes(actor));
  // Side-by-side: both models work on the same step at once.
  const parallelBlock = (stage: Stage, round: number) => {
    const gpt = pick(stage, round, "GPT"),
      claude = pick(stage, round, "Claude");
    const at = notesAt(stage, round);
    if (!gpt && !claude && !at.length) return null;
    return (
      <section className="stageBlock" key={`${stage}-${round}`}>
        {at}
        {(gpt || claude) && (
          <>
            {head(stage)}
            <div className="stageGrid">
              <Bubble call={gpt} actor="GPT" skipped={wasSkipped(round, "GPT")} />
              <Bubble call={claude} actor="Claude" skipped={wasSkipped(round, "Claude")} />
            </div>
          </>
        )}
      </section>
    );
  };
  // Single speaker, drawn as a chat turn on that model's side.
  // Notes for a stage render once, before its first speaker.
  const turnBlock = (
    stage: Stage,
    round: number,
    actor: Actor,
    { notes = true, title = true } = {},
  ) => {
    const call = pick(stage, round, actor);
    const at = notes ? notesAt(stage, round) : [];
    if (!call && !at.length) return null;
    return (
      <section className="stageBlock" key={`${stage}-${round}-${actor}`}>
        {at}
        {call && (
          <>
            {title && head(stage)}
            <div className={`turnRow ${actor.toLowerCase()}`}>
              <Bubble call={call} actor={actor} onOpenReport={onOpenReport} skipped={wasSkipped(round, actor)} />
            </div>
          </>
        )}
      </section>
    );
  };

  return (
    <div className="debate">
      <QuestionBubble project={project} />
      <div className="roundChips" role="group" aria-label="라운드 선택">
        {chips.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            className={filter === key ? "active" : ""}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {!calls.length && !notes.length && (
        <p className="empty">
          {project.status === "queued"
            ? "작업자 실행을 기다리고 있습니다. npm run dev 또는 npm start가 실행되어 있어야 합니다."
            : "아직 기록된 대화가 없습니다."}
        </p>
      )}
      {(planCall || notes.some((n) => n.appliedStage === "plan")) && show("plan") && (
        <div className="roundBlock">
          <div className="roundHead">
            <span>준비</span>
            <b>연구 준비</b>
          </div>
          {turnBlock("plan", 0, "GPT")}
        </div>
      )}
      {project.rounds.map((r) => {
        if (!show(`r${r.number}`)) return null;
        // A follow-up question reopened the research right before this round.
        const followUp = project.followUps?.find((f) => f.fromRound + 1 === r.number);
        return (
          <Fragment key={r.number}>
          {followUp && (
            <div className="followUpDivider" role="separator">
              <span>후속 질문</span>
              <b>{followUp.question}</b>
              <Stamp at={followUp.createdAt} />
            </div>
          )}
          <div className="roundBlock">
            <div className="roundHead">
              <span>라운드 {r.number}</span>
              <b>{codraft ? "공동 문서 다듬기" : relay ? "탐색 릴레이" : `질문 ${r.questions.length}개`}</b>
              <em>
                {r.novelty === undefined
                  ? "진행 중"
                  : `새 정보 ${Math.round(r.novelty * 100)}% · 남은 쟁점 ${r.requeued.length}개`}
              </em>
            </div>
            {!codraft && !relay && (
              <details className="restDetails roundQuestions">
                <summary>이번 라운드 질문</summary>
                <ol>
                  {r.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ol>
              </details>
            )}
            {relay ? (
              <>
                {turnBlock("explore", r.number, "Claude")}
                {turnBlock("explore", r.number, "GPT", {
                  notes: false,
                  title: !pick("explore", r.number, "Claude"),
                })}
              </>
            ) : codraft ? (
              <>
                {r.number === 1 && parallelBlock("draft", 1)}
                {r.number === 1 && turnBlock("merge", 1, "GPT")}
                {turnBlock("revise", r.number, "Claude")}
                {turnBlock("revise", r.number, "GPT", {
                  notes: false,
                  title: !pick("revise", r.number, "Claude"),
                })}
              </>
            ) : (
              debateStages.map((stage) => parallelBlock(stage, r.number))
            )}
          </div>
          </Fragment>
        );
      })}
      {codraft && !project.rounds.length && show("all") && (
        <div className="roundBlock">
          {parallelBlock("draft", 1)}
          {turnBlock("merge", 1, "GPT")}
        </div>
      )}
      {(synthesisCall || editCall) && show("synthesis") && (
        <div className="roundBlock">
          <div className="roundHead">
            <span>마무리</span>
            <b>최종 종합</b>
          </div>
          {synthesisCall && turnBlock("synthesis", synthesisCall.round, synthesisCall.actor)}
          {editCall && turnBlock("report-edit", editCall.round, editCall.actor)}
        </div>
      )}
      {pending.length > 0 && filter === "all" && (
        <div className="pendingNotes">
          {pending.map((n) => (
            <HumanNote key={n.id} note={n} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentPanel({ project }: { project: Project }) {
  const docs = project.documents ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  if (!docs.length)
    return <p className="empty">두 모델의 초안이 합쳐지면 공동 문서가 여기에 표시됩니다.</p>;
  const shared = docs.filter((d) => d.stage !== "draft");
  const current: DocumentVersion =
    docs.find((d) => d.version === picked) ?? shared.at(-1) ?? docs.at(-1)!;
  const label = (d: DocumentVersion) =>
    d.stage === "draft" ? `${d.author} 초안` : d.stage === "merge" ? "합본" : `R${d.round} ${d.author}`;
  return (
    <div className="documentPanel">
      <div className="versionBar" role="group" aria-label="문서 버전">
        {docs.map((d) => (
          <button
            key={d.version}
            type="button"
            aria-pressed={d.version === current.version}
            className={`${d.version === current.version ? "active" : ""} ${d.author.toLowerCase()}`}
            onClick={() => setPicked(d.version)}
          >
            v{d.version} · {label(d)}
            {d.stage === "revise" && (
              <em>
                {d.changes.some((c) => !/^\s*응답:/.test(c.target))
                  ? `${d.changes.filter((c) => !/^\s*응답:/.test(c.target)).length}건`
                  : "변경 없음"}
              </em>
            )}
          </button>
        ))}
      </div>
      <div className="documentLayout">
        <article className="report">
          <RichMarkdown>{current.markdown}</RichMarkdown>
        </article>
        <aside className="documentSide">
          <h3>
            v{current.version} · {current.author}
            <small>
              {stageLabels[current.stage]} ·{" "}
              {new Date(current.createdAt).toLocaleTimeString("ko-KR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </small>
          </h3>
          <b>변경 사항</b>
          {current.changes.length ? (
            <ul>
              {current.changes.map((c, i) => (
                <li key={i}>
                  <span>{c.target}</span>
                  <p>{c.reason}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="help">
              {current.stage === "draft" ? "독립 초안입니다." : "이 차례에는 변경이 없습니다."}
            </p>
          )}
          <b>남은 ⚖️ 쟁점 · 공백</b>
          {current.openIssues.length ? (
            <ul>
              {current.openIssues.map((q, i) => (
                <li key={i}>
                  <p>{q}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="help">남은 쟁점이 없습니다. 합의가 사실 검증을 뜻하지는 않습니다.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Earlier reports kept by "보고서 다시 쓰기"; Markdown renders only when opened. */
export function ReportHistory({
  history,
  followUps,
}: {
  history?: { createdAt: string; markdown: string }[];
  followUps?: { question: string; createdAt: string }[];
}) {
  if (!history?.length) return null;
  return (
    <details className="foldPanel reportHistory">
      <summary>
        이전 보고서
        <span>{history.length}개</span>
      </summary>
      <div className="reportVersions">
        {[...history].reverse().map((h, i) => (
          <ReportVersion
            key={h.createdAt + i}
            createdAt={h.createdAt}
            markdown={h.markdown}
            // The first follow-up asked after this report replaced it.
            before={followUps?.find((f) => f.createdAt >= h.createdAt)?.question}
          />
        ))}
      </div>
    </details>
  );
}

function ReportVersion({ createdAt, markdown, before }: { createdAt: string; markdown: string; before?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="reportVersion" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Stamp at={createdAt} /> 보고서
        <span>{before ? `후속 질문 "${firstLine(before).slice(0, 40)}" 전` : `${markdown.length.toLocaleString()}자`}</span>
      </summary>
      {open && (
        <article className="report">
          <RichMarkdown>{markdown}</RichMarkdown>
        </article>
      )}
    </details>
  );
}

export function KeyInsights({ project }: { project: Project }) {
  const byConf = [...project.claims].sort((a, b) => b.confidence - a.confidence);
  const reportKey = project.report ? splitKeyPoints(project.report).key : "";
  if (!byConf.length && !reportKey) return null;
  type C = (typeof byConf)[number];
  const column = (title: string, cls: string, items: C[], empty: string, detail: (c: C) => string) => (
    <div className={`insight ${cls}`}>
      <h3>
        {title} <span>{items.length}</span>
      </h3>
      {items.length ? (
        <ul>
          {items.slice(0, 3).map((c) => (
            <li key={c.id}>
              <p>{c.statement}</p>
              <small>{detail(c)}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="help">{empty}</p>
      )}
    </div>
  );
  const agreed = byConf.filter((c) => c.actors.length > 1 && c.status !== "contested");
  const contested = byConf.filter((c) => c.status === "contested");
  const needs = byConf.filter((c) => c.status === "needs-evidence");
  return (
    <section className="insights" aria-label="한눈에 보기">
      {reportKey && (
        <div className="keyPoints reportKey">
          <span className="keyLabel">보고서 핵심 요점</span>
          <SafeMarkdown>{reportKey}</SafeMarkdown>
        </div>
      )}
      {byConf.length > 0 && (
        // The three claim columns are long; keep them one click away.
        <details className="foldPanel">
          <summary>
            주장 정리
            <span>
              합의 {agreed.length} · 논쟁 {contested.length} · 근거 필요 {needs.length}
            </span>
          </summary>
        <div className="insightGrid">
          {column(
            "두 모델 합의",
            "agreed",
            agreed,
            "아직 두 모델이 함께 낸 주장이 없어요.",
            (c) => `확신 ${Math.round(c.confidence * 100)}% · 근거 ${c.sources.length}개`,
          )}
          {column(
            "논쟁 중",
            "contested",
            contested,
            "반론이 붙은 주장이 없어요.",
            (c) => (c.objections[0] ? `반론: ${c.objections[0]}` : c.actors.join(" + ")),
          )}
          {column(
            "근거 필요",
            "needs",
            needs,
            "모든 주장에 검색 근거가 연결됐어요.",
            (c) => c.actors.join(" + "),
          )}
        </div>
          <p className="help">모델끼리 합의했다고 사실이 확인된 건 아니에요.</p>
        </details>
      )}
    </section>
  );
}

export function InterventionBox({
  project,
  onError,
}: {
  project: Project;
  onError: (message: string) => void;
}) {
  const draftKey = `note:${project.id}`;
  const [text, setTextState] = useState(() => loadLocal<string>(draftKey) ?? "");
  const setText = (value: string) => {
    setTextState(value);
    saveLocal(draftKey, value);
  };
  const [target, setTarget] = useState<"both" | Actor>("both");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  if (project.status !== "queued" && project.status !== "running") return null;
  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setSent(false);
    try {
      const res = await fetch(`/api/projects/${project.id}/interventions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, target }),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      setText("");
      setSent(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="interventionBox"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="interventionHead">
        <b>방향 알려주기</b>
        <span>지금 단계가 끝나면 다음 단계부터 반영돼요.</span>
      </div>
      <MarkdownField
        id="intervention"
        label="방향 메모"
        hideLabel
        compact
        value={text}
        onChange={setText}
        maxLength={4000}
        disabled={busy}
        placeholder="예: 비용 측면을 더 조사해 주세요"
        onSubmitShortcut={() => void send()}
      />
      <div className="interventionActions">
        <label>
          받는 모델
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as "both" | Actor)}
            disabled={busy}
          >
            <option value="both">GPT + Claude</option>
            <option value="GPT">GPT만</option>
            <option value="Claude">Claude만</option>
          </select>
        </label>
        {sent && <span role="status">보냈어요. 다음 단계에 반영돼요.</span>}
        <button className="primary" disabled={busy || !text.trim()}>
          {busy ? "보내는 중…" : "보내기"}
        </button>
      </div>
    </form>
  );
}

type UpdateInfo = {
  supported: boolean;
  enabled: boolean;
  behind: number;
  current?: string;
  upstream?: string;
  commits: { sha: string; subject: string }[];
  canUpdate: boolean;
  reason?: string;
  pending: boolean;
  auto: boolean;
  build?: string;
  lastResult?: { state: "done" | "failed"; message: string; finishedAt: string };
};

/** Header badge: shows when the tracked GitHub branch has new commits. */
export function UpdateButton() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  const [phase, setPhase] = useState<"idle" | "requesting" | "restarting" | "failed">("idle");
  const [message, setMessage] = useState("");
  // The build this tab was loaded with; a different one means the app restarted
  // on a new version while this tab kept showing the old code.
  const firstBuild = useRef<string | undefined>(undefined);
  const [staleTab, setStaleTab] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);
  async function load(refresh = false) {
    try {
      const res = await fetch(`/api/update${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (!res.ok) return;
      const next: UpdateInfo = await res.json();
      if (next.build) {
        firstBuild.current ??= next.build;
        if (next.build !== firstBuild.current) setStaleTab(true);
      }
      setInfo(next);
    } catch {}
  }
  useEffect(() => {
    void load();
    // The server fetches GitHub at most every 30 minutes; match that here.
    const timer = setInterval(() => void load(), 30 * 60 * 1000);
    const wake = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  async function toggleAuto(auto: boolean) {
    setSavingAuto(true);
    try {
      const res = await fetch("/api/update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto }),
      });
      if (res.ok) setInfo(await res.json());
    } catch {
    } finally {
      setSavingAuto(false);
    }
  }
  async function apply() {
    setPhase("requesting");
    setMessage("");
    const requestedAt = Date.now();
    try {
      const res = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      setPhase("restarting");
      // The launcher stops the server, pulls, and restarts it. Wait for its result.
      const started = Date.now();
      const poll = async (): Promise<void> => {
        if (Date.now() - started > 15 * 60 * 1000) {
          setPhase("failed");
          setMessage("업데이트가 너무 오래 걸려요. 잠시 뒤 새로고침해 주세요.");
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const r = await fetch("/api/update", { cache: "no-store" });
          const s: UpdateInfo = await r.json();
          const result = s.lastResult;
          if (result && Date.parse(result.finishedAt) >= requestedAt && !s.pending) {
            if (result.state === "done") {
              location.reload();
              return;
            }
            setPhase("failed");
            setMessage(result.message);
            setInfo(s);
            return;
          }
        } catch {}
        return poll();
      };
      await poll();
    } catch (e) {
      setPhase("failed");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }
  if (staleTab)
    return (
      <div className="updateBanner">
        <button type="button" className="updateButton" onClick={() => location.reload()}>
          <span className="dotNew" aria-hidden />
          새 버전이 적용됐어요 · 새로고침
        </button>
      </div>
    );
  if (!info?.supported || !info.enabled || (!info.behind && phase === "idle")) return null;
  return (
    <div className="updateBanner">
      <button type="button" className="updateButton" onClick={() => setOpen(true)}>
        <span className="dotNew" aria-hidden />
        새 업데이트 {info.behind}개{info.auto && info.canUpdate ? " · 곧 자동 적용" : ""}
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className="updateDialog"
          aria-labelledby="updateTitle"
          onCancel={(e) => {
            if (phase === "requesting" || phase === "restarting") e.preventDefault();
            else setOpen(false);
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && phase !== "restarting") setOpen(false);
          }}
        >
          <div>
            <h2 id="updateTitle">새 버전이 있어요</h2>
            <p className="help">
              현재 {info.current} · {info.upstream}에 새 커밋 {info.behind}개
            </p>
            <ul>
              {info.commits.map((c) => (
                <li key={c.sha}>
                  <code>{c.sha}</code>
                  {c.subject}
                </li>
              ))}
            </ul>
            <p className="help">
              GitHub에서 최신 코드를 받아 앱을 다시 시작해요. 연구 기록과 설정은 그대로 남아요.
            </p>
            <label className="autoUpdateToggle">
              <input
                type="checkbox"
                checked={info.auto}
                disabled={savingAuto}
                onChange={(e) => void toggleAuto(e.target.checked)}
              />
              <span>
                <b>자동으로 업데이트</b>
                <small>30분마다 확인하고, 진행 중인 연구가 없을 때 적용해요.</small>
              </span>
            </label>
            {info.reason && phase === "idle" && <p className="error">{info.reason}</p>}
            {phase === "restarting" && (
              <p role="status">업데이트하는 중이에요. 앱이 다시 켜지면 자동으로 새로고침해요.</p>
            )}
            {phase === "failed" && <p className="error">{message}</p>}
            <div className="updateActions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setOpen(false);
                  if (phase === "failed") setPhase("idle");
                }}
                disabled={phase === "requesting" || phase === "restarting"}
              >
                닫기
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void apply()}
                disabled={!info.canUpdate || phase === "requesting" || phase === "restarting"}
              >
                {phase === "restarting" ? "업데이트 중…" : "지금 업데이트"}
              </button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}

/** What is running right now, plus project totals. */
export function ProjectNow({ project }: { project: Project }) {
  const running = project.calls.filter((c) => c.status === "running");
  const turn = project.conversation.turns.find((t) => t.status === "running");
  const live = running.length > 0 || Boolean(turn);
  const now = useNow(live || project.status === "running");
  const done = project.calls.filter((c) => c.status === "complete" && !c.replayed).length;
  const failed = project.calls.filter((c) => c.status === "failed").length;
  const finishedAt = [...project.calls].reverse().find((c) => c.finishedAt)?.finishedAt;
  const end =
    project.status === "running" || live ? now : Date.parse(finishedAt ?? project.updatedAt);
  return (
    <div className="projectNow">
      {running.length ? (
        <span className="nowLine">
          <span className="liveDot" aria-hidden /> 지금:{" "}
          {running.map((c, i) => (
            <span key={i}>
              {i > 0 && " · "}
              <b>{c.actor}</b> {stageLabels[c.stage]}
              {c.round ? ` R${c.round}` : ""} <Elapsed start={c.startedAt} running />
            </span>
          ))}
        </span>
      ) : turn ? (
        <span className="nowLine">
          <span className="liveDot" aria-hidden /> 지금: 후속 질문에 답하는 중{" "}
          <Elapsed start={turn.createdAt} running />
        </span>
      ) : (
        <span className="nowLine idle">진행 중인 호출이 없어요</span>
      )}
      <span className="nowTotals">
        총 {formatElapsed(Math.max(0, end - Date.parse(project.createdAt)))} · 호출 {done}회
        {failed ? ` · 실패 ${failed}회` : ""} · {project.tokens.toLocaleString()} 토큰
      </span>
    </div>
  );
}

/** Research relay: what was dropped, by whom, and why. */
export function ExclusionList({ project }: { project: Project }) {
  const items = project.exclusions ?? [];
  if (!items.length) return null;
  return (
    <section className="exclusionPanel" aria-label="제외한 자료">
      <h3>
        제외한 자료 <span>{items.length}</span>
      </h3>
      <ul>
        {items.map((e, i) => (
          <li key={i}>
            <span className="excludedTarget">{e.target}</span>
            <p>{e.reason}</p>
            <small>
              {e.actor} · R{e.round} · <Stamp at={e.at} />
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}

const CHECK_TEXT = {
  match: "원문 일치",
  partial: "원문 일부 일치",
  mismatch: "원문 불일치",
  unreachable: "접근 불가",
  skipped: "자동 확인 안 함",
} as const;
const GRADE_TEXT = { 1: "1차 자료", 2: "기관 자료", 3: "기타 자료" } as const;

/** Grade and page-check result of one cited source. */
export function SourceCheckBadges({ source }: { source: Project["claims"][number]["sources"][number] }) {
  if (!source.grade && !source.check) return null;
  return (
    <span className="sourceChecks">
      {source.grade && <b className={`gradeBadge g${source.grade}`}>{GRADE_TEXT[source.grade]}</b>}
      {source.check && (
        <b className={`checkBadge ${source.check.status}`} title={source.check.note}>
          {CHECK_TEXT[source.check.status]}
        </b>
      )}
      {source.check?.note && <small>{source.check.note}</small>}
    </span>
  );
}

export function gradeText(grade?: 1 | 2 | 3) {
  return grade ? GRADE_TEXT[grade] : "";
}

/** Claims that cannot both be true, found right before the report. */
export function ContradictionList({ project }: { project: Project }) {
  const items = project.contradictions ?? [];
  if (!items.length) return null;
  return (
    <section className="contradictionPanel" aria-label="서로 맞지 않는 주장">
      <h3>
        서로 맞지 않는 주장 <span>{items.length}</span>
      </h3>
      <ul>
        {items.map((c, i) => (
          <li key={i}>
            <span className="contradictionPair">{c.between}</span>
            <p>{c.reason}</p>
            <small>{c.actor}가 보고서 전에 찾았어요</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
