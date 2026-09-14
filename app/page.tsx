"use client";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Project } from "@/lib/types";
import type {
  AccountUsage,
  AccountUsageWindow,
  ProviderAccountUsage,
} from "@/lib/account-usage";
type Brief = Pick<
  Project,
  "id" | "topic" | "status" | "mode" | "createdAt" | "stage"
>;
const labels: Record<string, string> = {
  queued: "대기 중",
  running: "연구 중",
  complete: "완료",
  failed: "오류",
  interrupted: "중단",
  plan: "질문 분해",
  research: "독립 조사",
  critique: "상호비판",
  rebuttal: "반박 · 수정",
  synthesis: "최종 종합",
  conversation: "후속 대화",
  "conversation-synthesis": "공동 정리",
  "needs-evidence": "근거 필요",
  contested: "논쟁 중",
  "source-linked": "출처 연결",
};
function download(name: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SafeMarkdown({ children }: { children: string }) {
  return (
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
  );
}

function resetText(window?: AccountUsageWindow) {
  if (!window) return "한도 정보 없음";
  if (window.resetLabel) return `초기화 ${window.resetLabel}`;
  if (window.resetsAt) {
    return `초기화 ${new Date(window.resetsAt * 1000).toLocaleString("ko-KR", {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return "초기화 시간 미제공";
}

function LimitValue({ window }: { window?: AccountUsageWindow }) {
  return (
    <div className="limitValue">
      <small>{window?.label ?? "한도"}</small>
      <strong>{window ? `${window.remainingPercent}%` : "—"}</strong>
      <span>{window ? "남음" : "확인 불가"}</span>
      <em>{resetText(window)}</em>
    </div>
  );
}

function ProviderLimits({
  name,
  usage,
}: {
  name: "GPT" | "Claude";
  usage?: ProviderAccountUsage;
}) {
  return (
    <article className="providerLimits">
      <div className="providerName">
        <span className={`avatar ${name.toLowerCase()}`}>
          {name === "GPT" ? "G" : "C"}
        </span>
        <span>
          <b>{name}</b>
          <small>
            {usage?.status === "unavailable" ? "조회 불가" : "구독 한도"}
          </small>
        </span>
      </div>
      <LimitValue window={usage?.short} />
      <LimitValue window={usage?.weekly} />
    </article>
  );
}

export default function Page() {
  const [projects, setProjects] = useState<Brief[]>([]),
    [id, setId] = useState(""),
    [project, setProject] = useState<Project | null>(null);
  const [topic, setTopic] = useState(""),
    [mode, setMode] = useState<"mock" | "subscription">("mock"),
    [rounds, setRounds] = useState(8),
    [minRounds, setMinRounds] = useState(6),
    [threshold, setThreshold] = useState(0.12),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [accountUsage, setAccountUsage] = useState<AccountUsage | null>(null);
  const [message, setMessage] = useState("");
  const [messageTarget, setMessageTarget] = useState<
    "GPT" | "Claude" | "both"
  >("both");
  const [messageBusy, setMessageBusy] = useState(false);
  const [referenceText, setReferenceText] = useState("");
  const [attachments, setAttachments] = useState<
    { name: string; text: string }[]
  >([]);
  const [reading, setReading] = useState(false);
  async function attach(files: File[]) {
    setReading(true);
    setError("");
    try {
      if (attachments.length + files.length > 5)
        throw Error("파일은 최대 5개까지 첨부할 수 있습니다.");
      const added: { name: string; text: string }[] = [];
      for (const file of files) {
        if (!/\.(txt|md|csv|json|log)$/i.test(file.name))
          throw Error(
            "TXT, MD, CSV, JSON, LOG 파일을 지원합니다. PDF·Word·한글 문서는 내용을 복사해 참고 텍스트에 넣어주세요.",
          );
        if (file.size > 160000)
          throw Error(`${file.name}: 파일은 160KB 이하여야 합니다.`);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
        if (!text.trim() || text.length > 40000 || text.includes("\u0000"))
          throw Error(
            `${file.name}: 비어 있지 않은 UTF-8 텍스트 40,000자 이하가 필요합니다.`,
          );
        added.push({ name: file.name, text });
      }
      if (
        referenceText.length +
          [...attachments, ...added].reduce((n, f) => n + f.text.length, 0) >
        60000
      )
        throw Error("참고 텍스트와 파일 내용은 합계 60,000자까지 가능합니다.");
      setAttachments((previous) => [...previous, ...added]);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "파일을 읽지 못했습니다. UTF-8 형식을 확인하세요.",
      );
    } finally {
      setReading(false);
    }
  }
  const [tab, setTab] = useState("overview");
  useEffect(() => {
    if (id) return;
    let alive = true;
    async function refreshUsage() {
      try {
        const response = await fetch("/api/subscription-usage", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("usage unavailable");
        const usage = (await response.json()) as AccountUsage;
        if (alive) setAccountUsage(usage);
      } catch {
        if (alive)
          setAccountUsage(
            (current) =>
              current ?? {
                codex: { status: "unavailable" },
                claude: { status: "unavailable" },
                fetchedAt: new Date().toISOString(),
              },
          );
      }
    }
    void refreshUsage();
    const timer = setInterval(refreshUsage, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  useEffect(() => {
    let alive = true;
    let first = true;
    async function refresh() {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) throw Error("프로젝트 목록을 읽지 못했습니다.");
        const data = await res.json();
        if (alive) {
          setProjects(data.projects);
          setReady(data.liveReady);
          if (first) {
            setMode(data.defaultMode);
            first = false;
          }
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    }
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setProject(null);
    async function refresh() {
      try {
        const res = await fetch(`/api/projects/${id}`);
        if (!res.ok) throw Error("프로젝트를 읽지 못했습니다.");
        const p = await res.json();
        if (alive) setProject(p);
      } catch (e) {
        if (alive) setError(String(e));
      }
    }
    void refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          referenceText,
          attachments,
          mode,
          maxRounds: rounds,
          minRounds,
          noveltyThreshold: threshold,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      setId(data.id);
      setProject(data);
      setTab("overview");
      setProjects((p) => [data, ...p]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!project || !message.trim()) return;
    setMessageBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, target: messageTarget }),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      setProject((current) =>
        current
          ? {
              ...current,
              conversation: {
                ...current.conversation,
                turns: [...current.conversation.turns, data],
              },
            }
          : current,
      );
      setMessage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMessageBusy(false);
    }
  }
  async function retryMessage(turnId: string) {
    if (!project) return;
    setError("");
    try {
      const res = await fetch(
        `/api/projects/${project.id}/messages/${turnId}/retry`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      setProject((current) =>
        current
          ? {
              ...current,
              conversation: {
                ...current.conversation,
                turns: current.conversation.turns.map((turn) =>
                  turn.id === turnId ? data : turn,
                ),
              },
            }
          : current,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          <span className="brandIcon">◈</span> Research Studio
        </a>
        <div className="workspace">PERSONAL WORKSPACE</div>
        <button
          className="newProject"
          onClick={() => {
            setId("");
            setProject(null);
            setTopic("");
            setReferenceText("");
            setAttachments([]);
          }}
        >
          ＋ 새 연구 프로젝트
        </button>
        <div className="sideLabel">
          연구 라이브러리 <span>{projects.length}</span>
        </div>
        <nav aria-label="연구 프로젝트">
          {projects.map((p) => (
            <button
              key={p.id}
              className={`projectButton ${id === p.id ? "selected" : ""}`}
              onClick={() => {
                setId(p.id);
                setTab(p.status === "complete" ? "conversation" : "overview");
              }}
            >
              <span className={`dot ${p.status}`} />
              <span>
                {p.topic}
                <small>
                  {labels[p.status]} · {p.mode.toUpperCase()}
                </small>
              </span>
            </button>
          ))}
        </nav>
        <div className="sideFooter">
          <span className="dot complete" /> 로컬 저장소 연결됨
          <small>GPT + Claude · 자동 연구</small>
        </div>
      </aside>
      <main>
        <header>
          <span>
            워크스페이스 <b>/</b> {project ? "연구 프로젝트" : "새 연구"}
          </span>
          <span className="pill">LOCAL MVP</span>
        </header>
        <div className="content">
          {!id && (
            <section
              className="accountUsageStrip"
              aria-label="계정 구독 잔여 사용량"
              aria-live="polite"
            >
              <div className="usageStripHeading">
                <div>
                  <span className="eyebrow">SUBSCRIPTION STATUS</span>
                  <h2>구독 잔여 사용량</h2>
                </div>
                <span>
                  {accountUsage
                    ? `${new Date(accountUsage.fetchedAt).toLocaleTimeString(
                        "ko-KR",
                        {
                          hour: "2-digit",
                          minute: "2-digit",
                        },
                      )} 기준 · 60초마다 갱신`
                    : "확인 중…"}
                </span>
              </div>
              <div className="accountUsageGrid">
                <ProviderLimits name="GPT" usage={accountUsage?.codex} />
                <ProviderLimits name="Claude" usage={accountUsage?.claude} />
              </div>
            </section>
          )}
          {error && (
            <div role="alert" className="error">
              {error}
              <button onClick={() => setError("")}>닫기</button>
            </div>
          )}
          {!id ? (
            <>
              <div className="eyebrow">TWO PERSPECTIVES. DEEPER RESEARCH.</div>
              <h1>
                질문 하나에서,
                <br />
                <span>더 깊은 이해까지.</span>
              </h1>
              <p className="intro">
                GPT와 Claude가 독립적으로 조사하고, 서로의 주장을 검토합니다.
                <br />
                질문을 남기면 조사부터 최종 보고서까지 자동으로 이어집니다.
              </p>
              <form className="composer" onSubmit={submit}>
                <label htmlFor="topic">무엇을 깊이 연구할까요?</label>
                <textarea
                  id="topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  minLength={5}
                  maxLength={2000}
                  required
                  placeholder="예: 공공 Multi-Agent 환경에서 정보 분류와 에이전트 권한을 결합하는 정책의 가능성과 한계"
                />
                <label htmlFor="referenceText">참고 텍스트 · 선택</label>
                <textarea
                  id="referenceText"
                  value={referenceText}
                  onChange={(e) => setReferenceText(e.target.value)}
                  maxLength={20000}
                  placeholder="기존 메모, 연구 배경, 검토할 문서 내용을 붙여넣으세요."
                />
                <label htmlFor="attachments">참고 파일 · 선택</label>
                <input
                  id="attachments"
                  type="file"
                  multiple
                  accept=".txt,.md,.csv,.json,.log"
                  disabled={reading || busy}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    void attach(files);
                  }}
                />
                <p className="help">
                  TXT · MD · CSV · JSON · LOG (UTF-8), 최대 5개. 파일당 40,000자
                  / 160KB, 참고 자료 합계 60,000자. PDF·Word·한글은 내용을
                  복사해 위에 넣어주세요. 구독 모드에서는 참고 내용이 두 모델에
                  전달됩니다.
                </p>
                {reading && <p role="status">파일 읽는 중…</p>}
                {attachments.map((file, index) => (
                  <details className="questionHistory" key={index}>
                    <summary>
                      {file.name} · {file.text.length.toLocaleString()}자
                    </summary>
                    <pre className="prewrap">{file.text}</pre>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((files) =>
                          files.filter((_, i) => i !== index),
                        )
                      }
                    >
                      첨부 제거
                    </button>
                  </details>
                ))}
                <div className="formOptions">
                  <label>
                    실행 모드
                    <select
                      value={mode}
                      onChange={(e) =>
                        setMode(e.target.value as "mock" | "subscription")
                      }
                    >
                      <option value="mock">Mock · 키 없이 체험</option>
                      <option value="subscription" disabled={!ready}>
                        구독 · Codex + Claude Code
                      </option>
                    </select>
                  </label>
                  <label>
                    최대 라운드
                    <select
                      value={rounds}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setRounds(n);
                        setMinRounds((m) => Math.min(m, n));
                      }}
                    >
                      {Array.from({ length: 30 }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n} 라운드
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    최소 라운드
                    <select
                      value={minRounds}
                      onChange={(e) => setMinRounds(Number(e.target.value))}
                    >
                      {Array.from({ length: rounds }, (_, i) => i + 1).map(
                        (n) => (
                          <option key={n} value={n}>
                            {n} 라운드
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    새 정보 기준
                    <select
                      value={threshold}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                    >
                      <option value={0}>0% · 새 정보 없음</option>
                      <option value={0.12}>12% · 기본</option>
                      <option value={0.25}>25% · 빠른 수렴</option>
                    </select>
                  </label>
                </div>
                <p className="help">
                  최소 {minRounds}라운드 이후 수렴을 판단합니다. 최대 {rounds}
                  라운드 · 모델 호출 최대 {2 + 6 * rounds}회 (재시도·검색 제외).
                  최소와 최대를 같게 설정하면 지정한 라운드를 모두 수행합니다.
                </p>
                <div className="formBottom">
                  <span>
                    {mode === "mock"
                      ? "합성 예시로 전체 흐름을 확인합니다. API 비용 없음."
                      : "로그인된 두 구독의 사용량이 차감됩니다. API 자동 전환 없음."}
                  </span>
                  <button className="primary" disabled={busy || reading}>
                    {busy ? "생성 중…" : "연구 시작 ↗"}
                  </button>
                </div>
              </form>
              <div className="suggestions">
                <span>시작할 질문</span>
                {[
                  "공공 Multi-Agent 환경의 정보보호 정책과 권한 관리",
                  "도시 열섬을 줄이는 녹지 정책의 효과와 한계",
                ].map((t) => (
                  <button key={t} onClick={() => setTopic(t)}>
                    {t} ↗
                  </button>
                ))}
              </div>
              <div className="process">
                {[
                  ["01", "독립 조사", "서로의 답을 보기 전, 각자의 관점으로"],
                  ["02", "상호 검증", "비판과 반박으로 주장과 근거를 점검"],
                  ["03", "연구 종합", "남은 질문까지 담은 최종 보고서"],
                ].map(([n, title, desc]) => (
                  <div key={n}>
                    <span>{n}</span>
                    <h3>{title}</h3>
                    <p>{desc}</p>
                  </div>
                ))}
              </div>
            </>
          ) : !project ? (
            <p role="status">연구 기록을 불러오는 중…</p>
          ) : (
            <>
              <div className="projectTop">
                <div>
                  <div className="eyebrow">
                    AUTONOMOUS RESEARCH / {project.mode.toUpperCase()}
                  </div>
                  <h1 className="projectTitle">{project.topic}</h1>
                </div>
                <button
                  className="secondary"
                  onClick={() =>
                    download(
                      `research-${project.id}.json`,
                      JSON.stringify(project, null, 2),
                      "application/json",
                    )
                  }
                >
                  기록 내보내기 ↓
                </button>
              </div>
              {project.mode === "mock" && (
                <div className="notice">
                  MOCK MODE{" "}
                  <span>
                    합성 데이터로 실행 중입니다. 이 프로젝트의 주장과 출처는
                    실제 연구 결과가 아닙니다.
                  </span>
                </div>
              )}
              <div className="stats">
                <div>
                  <small>현재 상태</small>
                  <strong>
                    <span className={`dot ${project.status}`} />
                    {labels[project.status]}
                  </strong>
                  <p>{project.stage}</p>
                </div>
                <div>
                  <small>연구 라운드</small>
                  <strong>
                    {project.rounds.length}
                    <em> / {project.maxRounds}</em>
                  </strong>
                  <p>
                    최소 {project.minRounds ?? Math.min(6, project.maxRounds)} ·
                    최대 {project.maxRounds} 라운드
                  </p>
                </div>
                <div>
                  <small>주장 원장</small>
                  <strong>
                    {project.claims.length}
                    <em> claims</em>
                  </strong>
                  <p>출처 · 반론 추적</p>
                </div>
                <div>
                  <small>미해결 질문</small>
                  <strong>{project.unresolved.length}</strong>
                  <p>{project.conversation?.turns.length ?? 0}개 후속 대화</p>
                </div>
              </div>
              {project.error && (
                <div className="error" role="alert">
                  {project.error}
                </div>
              )}
              {project.stopReason && (
                <p className="stopReason">종료 사유 · {project.stopReason}</p>
              )}
              <div className="tabs" role="tablist" aria-label="연구 보기">
                {[
                  ["conversation", "대화"],
                  ["overview", "진행 과정"],
                  ["claims", "주장 · 근거"],
                  ["questions", "연구 질문"],
                  ["report", "최종 보고서"],
                  ["references", "참고 자료"],
                ].map(([key, label]) => (
                  <button
                    role="tab"
                    aria-selected={tab === key}
                    key={key}
                    onClick={() => setTab(key)}
                    className={tab === key ? "active" : ""}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <section role="tabpanel">
                {tab === "conversation" && (
                  <>
                    <div className="sectionHeading">
                      <div>
                        <h2>프로젝트 대화</h2>
                        <p className="help">
                          GPT와 Claude의 프로젝트 세션이 이어집니다. 질문마다
                          응답 대상을 선택할 수 있습니다.
                        </p>
                      </div>
                      <span>
                        {(project.conversation?.turns ?? []).filter(
                          (turn) => turn.status === "complete",
                        ).length}
                        개 답변 완료
                      </span>
                    </div>
                    <div className="chatLog" aria-live="polite">
                      {!(project.conversation?.turns ?? []).length && (
                        <div className="empty chatEmpty">
                          <h2>연구 결과에 이어서 질문하세요.</h2>
                          <p>
                            한 모델만 선택하거나 두 모델의 답을 동시에 받을 수
                            있습니다.
                          </p>
                        </div>
                      )}
                      {(project.conversation?.turns ?? []).map((turn) => (
                        <article className="chatTurn" key={turn.id}>
                          <div className="chatMessage userBubble">
                            <small>
                              나 · {turn.target === "both" ? "GPT + Claude" : turn.target}
                            </small>
                            <p>{turn.userText}</p>
                          </div>
                          {turn.status === "queued" && (
                            <div className="chatProgress" role="status">
                              답변 순서를 기다리고 있습니다…
                            </div>
                          )}
                          {turn.status === "running" && (
                            <div className="chatProgress" role="status">
                              {turn.target === "both"
                                ? "두 모델이 답변하고 있습니다…"
                                : `${turn.target}가 답변하고 있습니다…`}
                            </div>
                          )}
                          {turn.answer && (
                            <div className="chatMessage assistantBubble">
                              <small>
                                {turn.target === "both" ? "공동 정리" : turn.target}
                              </small>
                              <SafeMarkdown>{turn.answer}</SafeMarkdown>
                            </div>
                          )}
                          {(turn.responses.GPT || turn.responses.Claude) && (
                            <details className="modelDrafts">
                              <summary>
                                {turn.target === "both"
                                  ? "모델별 답변 보기"
                                  : "응답 정보 보기"}
                              </summary>
                              {(["GPT", "Claude"] as const).map(
                                (actor) =>
                                  turn.responses[actor] && (
                                    <div className="modelDraft" key={actor}>
                                      <b>{actor}</b>
                                      <SafeMarkdown>
                                        {turn.responses[actor]!.answer.summary}
                                      </SafeMarkdown>
                                      <small>{turn.responses[actor]!.model}</small>
                                    </div>
                                  ),
                              )}
                            </details>
                          )}
                          {turn.status === "failed" && (
                            <div className="error chatError" role="alert">
                              {turn.error ?? "답변 생성에 실패했습니다."}
                              <button
                                type="button"
                                onClick={() => void retryMessage(turn.id)}
                              >
                                다시 시도
                              </button>
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                    <form className="chatComposer" onSubmit={sendMessage}>
                      <label htmlFor="messageTarget">응답 대상</label>
                      <select
                        id="messageTarget"
                        value={messageTarget}
                        disabled={project.status !== "complete" || messageBusy}
                        onChange={(e) =>
                          setMessageTarget(
                            e.target.value as "GPT" | "Claude" | "both",
                          )
                        }
                      >
                        <option value="both">GPT + Claude 둘 다</option>
                        <option value="GPT">GPT만</option>
                        <option value="Claude">Claude만</option>
                      </select>
                      <label htmlFor="followupMessage" className="srOnly">
                        후속 질문
                      </label>
                      <textarea
                        id="followupMessage"
                        value={message}
                        disabled={project.status !== "complete" || messageBusy}
                        onChange={(e) => setMessage(e.target.value)}
                        minLength={1}
                        maxLength={10000}
                        required
                        placeholder={
                          project.status === "complete"
                            ? "이 연구에 이어서 질문하거나, 다음 작업을 요청하세요."
                            : "초기 연구가 완료되면 대화를 시작할 수 있습니다."
                        }
                      />
                      <button
                        className="primary"
                        disabled={
                          project.status !== "complete" ||
                          messageBusy ||
                          !message.trim()
                        }
                      >
                        {messageBusy ? "저장 중…" : "보내기 ↗"}
                      </button>
                    </form>
                  </>
                )}
                {tab === "references" && (
                  <>
                    <h2>연구에 전달한 참고 자료</h2>
                    <p className="help">
                      사용자 제공 자료이며, 내용의 사실 여부는 별도 검증이
                      필요합니다.
                    </p>
                    {project.referenceText && (
                      <article className="claim">
                        <h3>참고 텍스트</h3>
                        <p className="prewrap">{project.referenceText}</p>
                      </article>
                    )}
                    {(project.attachments ?? []).map((file, i) => (
                      <details className="questionHistory" key={i}>
                        <summary>
                          {file.name} · {file.text.length.toLocaleString()}자
                        </summary>
                        <pre className="prewrap">{file.text}</pre>
                        <button
                          className="secondary"
                          onClick={() =>
                            download(
                              file.name,
                              file.text,
                              "text/plain;charset=utf-8",
                            )
                          }
                        >
                          텍스트 다운로드 ↓
                        </button>
                      </details>
                    ))}
                    {!project.referenceText && !project.attachments?.length && (
                      <p className="empty">첨부한 참고 자료가 없습니다.</p>
                    )}
                  </>
                )}
                {tab === "overview" && (
                  <>
                    <div className="sectionHeading">
                      <h2>연구 타임라인</h2>
                      <span>진행 상황 자동 갱신</span>
                    </div>
                    {project.status === "queued" && (
                      <p className="empty">
                        작업자 실행을 기다리고 있습니다. npm run dev 또는 npm
                        start가 실행되어 있어야 합니다.
                      </p>
                    )}
                    {project.rounds.map((r) => (
                      <div className="roundInfo" key={r.number}>
                        ROUND {String(r.number).padStart(2, "0")}
                        <span>
                          질문 {r.questions.length}개 ·{" "}
                          {r.novelty === undefined
                            ? "진행 중"
                            : `새 정보 ${Math.round(r.novelty * 100)}% · 재조사 ${r.requeued.length}개`}
                        </span>
                      </div>
                    ))}
                    <div className="timeline">
                      {project.calls.map((c, i) => (
                        <details key={i} className="call">
                          <summary>
                            <span className={`avatar ${c.actor.toLowerCase()}`}>
                              {c.actor === "GPT" ? "G" : "C"}
                            </span>
                            <span>
                              <b>{labels[c.stage]}</b>
                              <small>
                                {c.actor} ·{" "}
                                {c.round === 0 ? "준비" : `라운드 ${c.round}`}
                              </small>
                            </span>
                            <span className={`callStatus ${c.status}`}>
                              {labels[c.status] ?? c.status}
                            </span>
                          </summary>
                          <div className="callBody">
                            {c.error && <p className="error">{c.error}</p>}
                            {c.result ? (
                              <>
                                <p className="prewrap">
                                  {c.result.answer.summary}
                                </p>
                                {c.result.answer.claims.map((a, j) => (
                                  <p key={j}>• {a.statement}</p>
                                ))}
                                {c.result.answer.critiques.map((a, j) => (
                                  <blockquote key={j}>
                                    <b>{a.claim}</b>
                                    <p>{a.objection}</p>
                                  </blockquote>
                                ))}
                                <small>
                                  {c.result.model} · {c.result.tokens} tokens
                                </small>
                              </>
                            ) : (
                              <p>응답 대기 중…</p>
                            )}
                          </div>
                        </details>
                      ))}
                    </div>
                  </>
                )}
                {tab === "claims" && (
                  <>
                    <div className="sectionHeading">
                      <h2>Claim & evidence ledger</h2>
                      <span>{project.claims.length}개 주장</span>
                    </div>
                    <p className="help">
                      출처 연결은 제공자 검색 응답에 URL이 있었다는 뜻입니다.
                      원문이 주장을 입증하는지는 별도 검토가 필요합니다.
                      확신도는 모델의 자체 평가입니다.
                    </p>
                    {!project.claims.length && (
                      <p className="empty">
                        첫 반박 단계가 끝나면 주장 원장이 표시됩니다.
                      </p>
                    )}
                    {project.claims.map((c) => (
                      <article className="claim" key={c.id}>
                        <div className="claimMeta">
                          <code>{c.id}</code>
                          <span className={`badge ${c.status}`}>
                            {labels[c.status]}
                          </span>
                          <small>
                            {c.actors.join(" + ")} · 확신도{" "}
                            {Math.round(c.confidence * 100)}%
                          </small>
                        </div>
                        <h3>{c.statement}</h3>
                        {c.sources.length ? (
                          c.sources.map((s, i) => (
                            <div className="source" key={i}>
                              <a
                                href={s.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                ↗ {s.title}
                              </a>
                              <span>
                                {s.provenance === "mock"
                                  ? "합성 예시"
                                  : s.provenance === "provider-cited"
                                    ? "검색 응답에서 확인"
                                    : "미확인 URL"}
                              </span>
                              <p>{s.excerpt}</p>
                            </div>
                          ))
                        ) : (
                          <p className="help">연결된 근거가 없습니다.</p>
                        )}
                        {c.objections.map((o, i) => (
                          <blockquote key={i}>반론 · {o}</blockquote>
                        ))}
                      </article>
                    ))}
                  </>
                )}
                {tab === "questions" && (
                  <>
                    <h2>처음 분해한 연구 질문</h2>
                    {project.questions.map((q, i) => (
                      <div className="question" key={i}>
                        <span>Q{String(i + 1).padStart(2, "0")}</span>
                        {q}
                      </div>
                    ))}
                    <h2>재조사 대기 · 남은 질문</h2>
                    <p className="help">
                      종료 시점에 남은 질문도 보고서에 보존됩니다.
                    </p>
                    {project.unresolved.map((q, i) => (
                      <div className="question" key={i}>
                        <span>↻</span>
                        {q}
                      </div>
                    ))}
                    {project.rounds.map((r) => (
                      <details className="questionHistory" key={r.number}>
                        <summary>
                          라운드 {r.number} · 재큐잉 {r.requeued.length}개
                        </summary>
                        {r.requeued.map((q, i) => (
                          <p key={i}>{q}</p>
                        ))}
                      </details>
                    ))}
                  </>
                )}
                {tab === "report" &&
                  (project.report ? (
                    <>
                      <div className="sectionHeading">
                        <h2>최종 종합 보고서</h2>
                        <button
                          className="primary"
                          onClick={() =>
                            download(
                              `research-${project.id}.md`,
                              project.report!,
                            )
                          }
                        >
                          Markdown 다운로드 ↓
                        </button>
                      </div>
                      <article className="report">
                        <SafeMarkdown>{project.report}</SafeMarkdown>
                      </article>
                    </>
                  ) : (
                    <div className="empty">
                      <h2>연구를 종합하고 있습니다.</h2>
                      <p>
                        연구가 종료되면 미해결 질문과 출처를 포함한 보고서가
                        표시됩니다.
                      </p>
                    </div>
                  ))}
              </section>
            </>
          )}
          <footer>
            RESEARCH STUDIO <span>Independent thinking. Shared evidence.</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
