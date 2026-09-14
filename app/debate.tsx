"use client";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  research: "독립 조사",
  critique: "상호비판",
  rebuttal: "반박 · 수정",
  synthesis: "최종 종합",
  conversation: "후속 대화",
  "conversation-synthesis": "공동 정리",
};
const stageHints: Record<string, string> = {
  plan: "GPT가 주제를 연구 질문으로 나눕니다.",
  draft: "서로의 글을 보지 않고 각자 전체 초안을 씁니다.",
  merge: "두 초안을 하나로 합치고, 갈리는 부분은 ⚖️ 쟁점으로 남깁니다.",
  revise: "상대가 고친 최신 문서를 이어받아 근거와 함께 수정합니다.",
  research: "서로의 답을 보지 않고 각자 조사합니다.",
  critique: "상대의 주장에서 약한 근거와 빈틈을 찾습니다.",
  rebuttal: "받은 비판에 답하고 주장을 고치거나 거둡니다.",
  synthesis: "원장과 남은 질문을 모아 보고서를 씁니다.",
};

export function SafeMarkdown({
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
}

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

export function RichMarkdown({ children }: { children: string }) {
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
}

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
  onSubmitShortcut?: () => void;
};

export function MarkdownField(props: FieldProps) {
  const [preview, setPreview] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Wrap the selection, or prefix the current line, with Markdown syntax.
  function format(before: string, after = "", linePrefix = false) {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e, value } = el;
    let next: string, from: number, to: number;
    if (linePrefix) {
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      next = value.slice(0, lineStart) + before + value.slice(lineStart);
      from = s + before.length;
      to = e + before.length;
    } else {
      const selected = value.slice(s, e) || "텍스트";
      next = value.slice(0, s) + before + selected + after + value.slice(e);
      from = s + before.length;
      to = from + selected.length;
    }
    if (props.maxLength && next.length > props.maxLength) return;
    props.onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from, to);
    });
  }
  const tools: [string, string, () => void][] = [
    ["굵게", "B", () => format("**", "**")],
    ["제목", "H", () => format("### ", "", true)],
    ["목록", "• 목록", () => format("- ", "", true)],
    ["인용", "❝ 인용", () => format("> ", "", true)],
    ["코드", "</>", () => format("`", "`")],
  ];
  return (
    <div className={`mdField ${props.compact ? "compact" : ""}`}>
      <div className="mdBar">
        <label htmlFor={props.id}>{props.label}</label>
        <div className="mdTabs" role="tablist" aria-label={`${props.label} 보기`}>
          {[false, true].map((mode) => (
            <button
              key={String(mode)}
              type="button"
              role="tab"
              aria-selected={preview === mode}
              className={preview === mode ? "active" : ""}
              onClick={() => setPreview(mode)}
            >
              {mode ? "미리보기" : "작성"}
            </button>
          ))}
        </div>
      </div>
      {!preview && (
        <div className="mdToolbar" aria-label="Markdown 서식">
          {tools.map(([title, text, run]) => (
            <button
              key={title}
              type="button"
              onClick={run}
              disabled={props.disabled}
              title={title}
              aria-label={title}
            >
              {text}
            </button>
          ))}
          <span>Markdown 지원{props.onSubmitShortcut ? " · ⌘/Ctrl+Enter 전송" : ""}</span>
        </div>
      )}
      <textarea
        ref={ref}
        id={props.id}
        hidden={preview}
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
      {preview && (
        <div className="mdPreview">
          {props.value.trim() ? (
            <RichMarkdown>{props.value}</RichMarkdown>
          ) : (
            <p className="help">미리볼 내용이 없습니다.</p>
          )}
        </div>
      )}
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
            <span className={`avatar ${actor.toLowerCase()}`}>{actor === "GPT" ? "G" : "C"}</span>
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

function Bubble({
  call,
  actor,
  onOpenReport,
}: {
  call?: Call;
  actor: Actor;
  onOpenReport?: () => void;
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
  const writesDocument = editing || call.stage === "draft";
  return (
    <article className={cls}>
      <div className="bubbleHead">
        <span className={`avatar ${actor.toLowerCase()}`}>{actor === "GPT" ? "G" : "C"}</span>
        <span>
          <b>{actor}</b>
          <small>{call.result?.model ?? (call.status === "running" ? "응답 중" : "")}</small>
        </span>
        <span className={`callStatus ${call.status}`}>
          {call.status === "running"
            ? "작성 중"
            : call.status === "failed"
              ? "실패"
              : call.replayed
                ? "저장본 재생"
                : "완료"}{" "}
          <Elapsed start={call.startedAt} end={call.finishedAt} running={call.status === "running"} />
        </span>
      </div>
      {call.status === "running" && (
        <div className="typing" role="status" aria-label={`${actor} 응답 작성 중`}>
          <i />
          <i />
          <i />
        </div>
      )}
      {call.error && <p className="error">{call.error}</p>}
      {a && (
        <>
          {a.questions.length > 0 && (
            <ol className="pointList">
              {a.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          )}
          {key && (
            <div className="keyPoints">
              <span className="keyLabel">핵심 요점</span>
              <SafeMarkdown>{key}</SafeMarkdown>
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
          {editing && (
            <div className="changeList">
              <b>{call.stage === "merge" ? "합치면서 정한 것" : "이번 차례 변경 사항"}</b>
              {a.critiques.length ? (
                <ul>
                  {a.critiques.map((c, i) => (
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
          {!editing && a.critiques.length > 0 && (
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
              <details className="restDetails">
                <summary>{writesDocument ? "이 버전 문서 전체 보기" : "전체 설명 보기"}</summary>
                <SafeMarkdown>{rest}</SafeMarkdown>
              </details>
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
  return (
    <div className={`humanNote ${note.appliedAt ? "" : "pending"}`}>
      <div className="noteHead">
        <span className="avatar human">나</span>
        <span>
          <b>사람 개입</b>
          <small>
            {note.target === "both" ? "GPT + Claude" : `${note.target}에게`} ·{" "}
            {note.appliedAt && note.appliedStage
              ? `${stageLabels[note.appliedStage]} 단계에 반영됨`
              : "다음 단계 시작 시 반영 예정"}
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
          내 질문 · {new Date(project.createdAt).toLocaleString("ko-KR", {
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
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
  const calls = project.calls.filter((c) => c.stage in stageHints);
  const notes = project.interventions ?? [];
  const pending = notes.filter((n) => !n.appliedAt);
  const planCall = calls.find((c) => c.stage === "plan");
  const synthesisCall = calls.find((c) => c.stage === "synthesis");
  const chips = [
    ["all", "전체"],
    ...(planCall ? [["plan", "준비"]] : []),
    ...project.rounds.map((r) => [`r${r.number}`, `라운드 ${r.number}`]),
    ...(synthesisCall ? [["synthesis", "종합"]] : []),
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
              <Bubble call={gpt} actor="GPT" />
              <Bubble call={claude} actor="Claude" />
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
              <Bubble call={call} actor={actor} onOpenReport={onOpenReport} />
            </div>
          </>
        )}
      </section>
    );
  };

  return (
    <div className="debate">
      <QuestionBubble project={project} />
      <div className="roundChips" role="tablist" aria-label="라운드 선택">
        {chips.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
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
            <span>PREP</span>
            <b>연구 준비</b>
          </div>
          {turnBlock("plan", 0, "GPT")}
        </div>
      )}
      {project.rounds.map((r) => {
        if (!show(`r${r.number}`)) return null;
        return (
          <div className="roundBlock" key={r.number}>
            <div className="roundHead">
              <span>ROUND {String(r.number).padStart(2, "0")}</span>
              <b>{codraft ? "공동 문서 다듬기" : `질문 ${r.questions.length}개`}</b>
              <em>
                {r.novelty === undefined
                  ? "진행 중"
                  : `새 정보 ${Math.round(r.novelty * 100)}% · 남은 쟁점 ${r.requeued.length}개`}
              </em>
            </div>
            {!codraft && (
              <details className="restDetails roundQuestions">
                <summary>이번 라운드 질문</summary>
                <ol>
                  {r.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ol>
              </details>
            )}
            {codraft ? (
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
        );
      })}
      {codraft && !project.rounds.length && show("all") && (
        <div className="roundBlock">
          {parallelBlock("draft", 1)}
          {turnBlock("merge", 1, "GPT")}
        </div>
      )}
      {synthesisCall && show("synthesis") && (
        <div className="roundBlock">
          <div className="roundHead">
            <span>FINAL</span>
            <b>최종 종합</b>
          </div>
          {turnBlock("synthesis", synthesisCall.round, synthesisCall.actor)}
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
      <div className="versionBar" role="tablist" aria-label="문서 버전">
        {docs.map((d) => (
          <button
            key={d.version}
            type="button"
            role="tab"
            aria-selected={d.version === current.version}
            className={`${d.version === current.version ? "active" : ""} ${d.author.toLowerCase()}`}
            onClick={() => setPicked(d.version)}
          >
            v{d.version} · {label(d)}
            {d.stage === "revise" && <em>{d.changes.length ? `${d.changes.length}건` : "변경 없음"}</em>}
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
  return (
    <section className="insights" aria-label="한눈에 보기">
      {reportKey && (
        <div className="keyPoints reportKey">
          <span className="keyLabel">보고서 핵심 요점</span>
          <SafeMarkdown>{reportKey}</SafeMarkdown>
        </div>
      )}
      {byConf.length > 0 && (
        <div className="insightGrid">
          {column(
            "두 모델 합의",
            "agreed",
            byConf.filter((c) => c.actors.length > 1 && c.status !== "contested"),
            "아직 두 모델이 함께 낸 주장이 없습니다.",
            (c) => `확신 ${Math.round(c.confidence * 100)}% · 근거 ${c.sources.length}개`,
          )}
          {column(
            "논쟁 중",
            "contested",
            byConf.filter((c) => c.status === "contested"),
            "반론이 붙은 주장이 없습니다.",
            (c) => (c.objections[0] ? `반론: ${c.objections[0]}` : c.actors.join(" + ")),
          )}
          {column(
            "근거 필요",
            "needs",
            byConf.filter((c) => c.status === "needs-evidence"),
            "모든 주장에 검색 근거가 연결됐습니다.",
            (c) => c.actors.join(" + "),
          )}
        </div>
      )}
      <p className="help">모델끼리 합의했다고 사실이 검증된 것은 아닙니다.</p>
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
        <b>✋ 토론에 끼어들기</b>
        <span>
          진행 중인 호출이 끝나고 다음 단계가 시작될 때 전달됩니다. 방향 제시, 놓친 관점, 잘못된 전제
          지적에 쓰세요. 모델은 이 메모를 근거로 인용하지 않습니다.
        </span>
      </div>
      <MarkdownField
        id="intervention"
        label="개입 메모"
        compact
        value={text}
        onChange={setText}
        maxLength={4000}
        disabled={busy}
        placeholder={"예: ### 방향 수정\n- **비용 측면**을 더 조사해 주세요\n- 2024년 이전 자료는 제외"}
        onSubmitShortcut={() => void send()}
      />
      <div className="interventionActions">
        <label>
          전달 대상
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
        {sent && <span role="status">접수됨 · 다음 단계에 반영됩니다</span>}
        <button className="primary" disabled={busy || !text.trim()}>
          {busy ? "보내는 중…" : "다음 단계에 반영 ↗"}
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
  lastResult?: { state: "done" | "failed"; message: string; finishedAt: string };
};

/** Header badge: shows when the tracked GitHub branch has new commits. */
export function UpdateButton() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "requesting" | "restarting" | "failed">("idle");
  const [message, setMessage] = useState("");
  async function load(refresh = false) {
    try {
      const res = await fetch(`/api/update${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (res.ok) setInfo(await res.json());
    } catch {}
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
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
          setMessage("업데이트가 너무 오래 걸립니다. 터미널 로그를 확인하세요.");
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
  if (!info?.supported || !info.enabled || (!info.behind && phase === "idle")) return null;
  return (
    <div className="updateBanner">
      <button type="button" className="updateButton" onClick={() => setOpen(true)}>
        <span className="dotNew" aria-hidden />
        새 업데이트 {info.behind}개
      </button>
      {open && (
        <div className="updateDialog" role="dialog" aria-modal="true" aria-labelledby="updateTitle">
          <div>
            <h2 id="updateTitle">업데이트가 있습니다</h2>
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
              누르면 GitHub에서 최신 코드를 받아(git pull --ff-only) 필요한 경우 의존성을 다시 설치하고 앱을
              재시작합니다. 연구 기록과 설정(.env.local, data/)은 그대로 유지됩니다.
            </p>
            {info.reason && phase === "idle" && <p className="error">{info.reason}</p>}
            {phase === "restarting" && (
              <p role="status">업데이트 적용 중… 앱이 재시작되면 자동으로 새로고침됩니다.</p>
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
        </div>
      )}
    </div>
  );
}
