"use client";
import { useEffect, useState } from "react";
import type { ModelChoices, Project } from "@/lib/types";
import {
  DebateThread,
  DocumentPanel,
  Elapsed,
  InterventionBox,
  KeyInsights,
  MarkdownField,
  ModelChips,
  ModelPicker,
  RichMarkdown,
  UpdateButton,
  loadLocal,
  saveLocal,
  cleanModels,
  firstLine,
  stageLabels,
  type ModelDefaults,
} from "./debate";
import { PDF_MAX_BYTES, extractPdfText } from "./pdf";
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
  ...stageLabels,
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
    [strategy, setStrategy] = useState<"codraft" | "debate">("codraft"),
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
  const [modelDefaults, setModelDefaults] = useState<ModelDefaults>();
  const [models, setModels] = useState<ModelChoices>({});
  const [chatModels, setChatModels] = useState<ModelChoices>({});
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
      const used = () =>
        referenceText.length +
        [...attachments, ...added].reduce((n, f) => n + f.text.length, 0);
      for (const file of files) {
        if (/\.pdf$/i.test(file.name)) {
          if (file.size > PDF_MAX_BYTES)
            throw Error(`${file.name}: PDF는 20MB 이하여야 합니다.`);
          // Long PDFs keep their first pages within the per-file and total budgets.
          const budget = Math.min(40000, 60000 - used()) - 120;
          if (budget < 500)
            throw Error("참고 자료 합계 60,000자를 넘어 PDF를 더 첨부할 수 없습니다.");
          const pdf = await extractPdfText(file, budget);
          added.push({
            name: file.name,
            text: pdf.truncated
              ? `${pdf.text}\n\n[안내: 전체 ${pdf.pages}쪽 중 글자 수 제한으로 앞부분만 포함했습니다.]`
              : pdf.text,
          });
          continue;
        }
        if (!/\.(txt|md|csv|json|log)$/i.test(file.name))
          throw Error(
            "PDF, TXT, MD, CSV, JSON, LOG 파일을 지원합니다. Word·한글 문서는 PDF로 저장하거나 내용을 복사해 참고 텍스트에 넣어주세요.",
          );
        if (file.size > 160000)
          throw Error(`${file.name}: 텍스트 파일은 160KB 이하여야 합니다.`);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
        if (!text.trim() || text.length > 40000 || text.includes("\u0000"))
          throw Error(
            `${file.name}: 비어 있지 않은 UTF-8 텍스트 40,000자 이하가 필요합니다.`,
          );
        added.push({ name: file.name, text });
      }
      if (used() > 60000)
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
  const [restored, setRestored] = useState(false);
  // Reopen the last project/tab and unsent drafts after a reload or restart.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const p = params.get("p");
    if (p && /^[a-f0-9-]{36}$/.test(p)) {
      setId(p);
      setTab(params.get("tab") ?? "overview");
    }
    const draft = loadLocal<{
      topic?: string;
      referenceText?: string;
      attachments?: { name: string; text: string }[];
      strategy?: "codraft" | "debate";
    }>("draft");
    if (draft) {
      setTopic(draft.topic ?? "");
      setReferenceText(draft.referenceText ?? "");
      setAttachments(draft.attachments ?? []);
      if (draft.strategy) setStrategy(draft.strategy);
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    const url = id ? `?p=${id}&tab=${encodeURIComponent(tab)}` : location.pathname;
    history.replaceState(null, "", url);
  }, [id, tab, restored]);
  useEffect(() => {
    if (!restored) return;
    saveLocal(
      "draft",
      topic || referenceText || attachments.length
        ? { topic, referenceText, attachments, strategy }
        : undefined,
    );
  }, [topic, referenceText, attachments, strategy, restored]);
  useEffect(() => {
    if (id) setMessage(loadLocal<string>(`chat:${id}`) ?? "");
  }, [id]);
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
          setModelDefaults(data.modelDefaults);
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
    setChatModels({});
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
          strategy,
          models: mode === "subscription" ? cleanModels(models) : undefined,
          maxRounds: rounds,
          minRounds,
          noveltyThreshold: threshold,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      setId(data.id);
      setTopic("");
      setReferenceText("");
      setAttachments([]);
      setProject(data);
      setTab("overview");
      setProjects((p) => [data, ...p]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function sendMessage(e?: React.FormEvent) {
    e?.preventDefault();
    if (!project || !message.trim() || messageBusy) return;
    setMessageBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          target: messageTarget,
          models: project.mode === "subscription" ? cleanModels(chatModels) : undefined,
        }),
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
      saveLocal(`chat:${project.id}`, "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMessageBusy(false);
    }
  }
  async function resumeProject() {
    if (!project) return;
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      setProject((current) =>
        current ? { ...current, status: "queued", stage: "이어서 실행 대기", error: undefined } : current,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function retryMessage(turnId: string) {
    if (!project) return;
    setError("");
    try {
      const res = await fetch(
        `/api/projects/${project.id}/messages/${turnId}/retry`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
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
          <span className="brandIcon">◈</span> 우리의장난감
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
                setTab("overview");
              }}
            >
              <span className={`dot ${p.status}`} />
              <span>
                {firstLine(p.topic)}
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
          <span className="updateBanner">
            <UpdateButton />
            <span className="pill">LOCAL</span>
          </span>
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
                GPT와 Claude가 각자 초안을 쓰고, 하나로 합친 문서를 번갈아 다듬습니다.
                <br />
                질문을 남기면 초안부터 최종 보고서까지 자동으로 이어지고, 중간에 끼어들 수도 있습니다.
              </p>
              <form className="composer" onSubmit={submit}>
                <MarkdownField
                  id="topic"
                  label="무엇을 깊이 연구할까요?"
                  value={topic}
                  onChange={setTopic}
                  minLength={5}
                  maxLength={2000}
                  required
                  placeholder={
                    "예: 공공 Multi-Agent 환경에서 정보 분류와 에이전트 권한을 결합하는 정책의 가능성과 한계\n\n### 특히 궁금한 점\n- **권한 위임** 범위\n- 국내외 사례"
                  }
                />
                <MarkdownField
                  id="referenceText"
                  label="참고 텍스트 · 선택"
                  value={referenceText}
                  onChange={setReferenceText}
                  maxLength={20000}
                  placeholder="기존 메모, 연구 배경, 검토할 문서 내용을 붙여넣으세요. Markdown 제목·목록을 쓰면 모델이 구조를 더 잘 파악합니다."
                />
                <label htmlFor="attachments">참고 파일 · 선택</label>
                <input
                  id="attachments"
                  type="file"
                  multiple
                  accept=".pdf,.txt,.md,.csv,.json,.log"
                  disabled={reading || busy}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    void attach(files);
                  }}
                />
                <p className="help">
                  PDF(20MB 이하, 텍스트가 있는 PDF) · TXT · MD · CSV · JSON · LOG,
                  최대 5개. 파일당 40,000자, 참고 자료 합계 60,000자. PDF는 브라우저에서
                  텍스트만 뽑아 쪽 번호와 함께 전달하고, 길면 앞부분만 넣습니다. 스캔
                  이미지 PDF·Word·한글은 텍스트를 복사해 위에 넣어주세요.
                </p>
                {reading && <p role="status">파일 읽는 중… PDF는 쪽수에 따라 몇 초 걸릴 수 있습니다.</p>}
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
                    협업 방식
                    <select
                      value={strategy}
                      onChange={(e) => setStrategy(e.target.value as "codraft" | "debate")}
                    >
                      <option value="codraft">공동 초안 · 합치고 번갈아 수정 (권장)</option>
                      <option value="debate">토론 · 조사→비판→반박</option>
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
                {mode === "subscription" ? (
                  <div className="modelSection">
                    <div className="modelSectionHead">
                      <b>모델 선택</b>
                      <span>
                        비워 두면 .env 기본값을 씁니다. 내 구독 계정에서 쓸 수 있는
                        모델이어야 합니다.
                      </span>
                    </div>
                    <ModelPicker
                      value={models}
                      onChange={setModels}
                      defaults={modelDefaults}
                      disabled={busy}
                    />
                  </div>
                ) : (
                  <p className="help">
                    Mock 모드는 모델을 호출하지 않습니다. 모델을 고르려면 구독 모드를
                    선택하세요.
                  </p>
                )}
                <p className="help">
                  최소 {minRounds}라운드 이후 수렴을 판단합니다. 최대 {rounds}
                  라운드 · 모델 호출 최대{" "}
                  {strategy === "codraft" ? 5 + 2 * rounds : 2 + 6 * rounds}회 (재시도·검색 제외).
                  {strategy === "codraft"
                    ? " 공동 초안: 두 모델이 각자 초안을 쓰고, GPT가 합친 문서를 Claude와 GPT가 번갈아 고칩니다. 둘 다 더 고칠 게 없다고 하면 끝납니다."
                    : " 토론: 매 라운드 독립 조사 → 상호비판 → 반박을 반복합니다."}
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
                  ["01", "각자 초안", "서로의 글을 보기 전, 각자의 관점으로"],
                  ["02", "합치고 번갈아 수정", "갈리는 부분은 ⚖️ 쟁점으로 남기고 근거로 다듬기"],
                  ["03", "최종 보고서", "남은 쟁점과 질문까지 담아 정리"],
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
                  <h1 className="projectTitle">{firstLine(project.topic)}</h1>
                  {project.topic.trim() !== firstLine(project.topic) && (
                    <details className="topicDetails">
                      <summary>연구 질문 전문 보기</summary>
                      <RichMarkdown>{project.topic}</RichMarkdown>
                    </details>
                  )}
                  <ModelChips project={project} defaults={modelDefaults} />
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
              {(project.status === "failed" || project.status === "interrupted") &&
                project.mode !== "live" && (
                  <div className="resumeBar">
                    <span>
                      완료된 {project.calls.filter((c) => c.status === "complete").length}개 단계는 저장돼
                      있습니다. 한도·로그인 문제를 해결한 뒤 이어서 실행하면 멈춘 단계부터 다시 호출합니다.
                    </span>
                    <button className="primary" onClick={() => void resumeProject()}>
                      이어서 실행 ↻
                    </button>
                  </div>
                )}
              {project.stopReason && (
                <p className="stopReason">종료 사유 · {project.stopReason}</p>
              )}
              <div className="tabs" role="tablist" aria-label="연구 보기">
                {[
                  ["overview", project.strategy === "codraft" ? "협업 과정" : "토론"],
                  ...(project.strategy === "codraft" ? [["document", "공동 문서"]] : []),
                  ["conversation", "대화"],
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
                              나 · {turn.target === "both" ? "GPT + Claude" : turn.target}{" "}
                              {turn.status !== "queued" && (
                                <Elapsed
                                  start={turn.createdAt}
                                  end={turn.updatedAt}
                                  running={turn.status === "running"}
                                />
                              )}
                            </small>
                            <RichMarkdown>{turn.userText}</RichMarkdown>
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
                              <RichMarkdown>{turn.answer}</RichMarkdown>
                            </div>
                          )}
                          {turn.target === "both" &&
                            (turn.responses.GPT || turn.responses.Claude) && (
                              <details className="modelDrafts">
                                <summary>GPT · Claude 답변 나란히 보기</summary>
                                <div className="draftGrid">
                                  {(["GPT", "Claude"] as const).map(
                                    (actor) =>
                                      turn.responses[actor] && (
                                        <div
                                          className={`modelDraft ${actor.toLowerCase()}`}
                                          key={actor}
                                        >
                                          <b>{actor}</b>
                                          <small>{turn.responses[actor]!.model}</small>
                                          <RichMarkdown>
                                            {turn.responses[actor]!.answer.summary}
                                          </RichMarkdown>
                                        </div>
                                      ),
                                  )}
                                </div>
                              </details>
                            )}
                          {turn.target !== "both" && turn.responses[turn.target] && (
                            <small className="turnModel">
                              {turn.responses[turn.target]!.model}
                            </small>
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
                      <MarkdownField
                        id="followupMessage"
                        label="후속 질문"
                        compact
                        value={message}
                        disabled={project.status !== "complete" || messageBusy}
                        onChange={(value) => {
                          setMessage(value);
                          saveLocal(`chat:${project.id}`, value);
                        }}
                        minLength={1}
                        maxLength={10000}
                        required
                        placeholder={
                          project.status === "complete"
                            ? "이 연구에 이어서 질문하거나, 다음 작업을 요청하세요."
                            : "초기 연구가 완료되면 대화를 시작할 수 있습니다. 진행 중에는 토론 탭에서 개입할 수 있습니다."
                        }
                        onSubmitShortcut={() => void sendMessage()}
                      />
                      <div className="chatActions">
                        <label>
                          응답 대상
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
                        </label>
                        {project.mode === "subscription" && (
                          <details className="chatModelDetails">
                            <summary>이번 질문의 모델 바꾸기</summary>
                            <ModelPicker
                              value={chatModels}
                              onChange={setChatModels}
                              defaults={{
                                GPT: {
                                  model:
                                    project.models?.GPT?.model ??
                                    modelDefaults?.GPT.model ??
                                    "",
                                  effort:
                                    project.models?.GPT?.effort ??
                                    modelDefaults?.GPT.effort ??
                                    "",
                                },
                                Claude: {
                                  model:
                                    project.models?.Claude?.model ??
                                    modelDefaults?.Claude.model ??
                                    "",
                                  effort:
                                    project.models?.Claude?.effort ??
                                    modelDefaults?.Claude.effort ??
                                    "",
                                },
                              }}
                              disabled={messageBusy}
                            />
                          </details>
                        )}
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
                      </div>
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
                    <KeyInsights project={project} />
                    <div className="sectionHeading">
                      <div>
                        <h2>
                          {project.strategy === "codraft" ? "GPT ↔ Claude 공동 작업" : "GPT ↔ Claude 토론"}
                        </h2>
                        <p className="help">
                          {project.strategy === "codraft"
                            ? "각자 초안 → 합본 → 번갈아 수정 순서로, 누가 무엇을 왜 고쳤는지 대화처럼 보여줍니다."
                            : "라운드마다 독립 조사 → 상호비판 → 반박 순서로 두 모델의 대화를 나란히 보여줍니다."}
                        </p>
                      </div>
                      <span>
                        {project.status === "running" ? "실시간 갱신 중" : labels[project.status]}
                      </span>
                    </div>
                    <DebateThread
                      project={project}
                      onOpenReport={() => setTab("report")}
                    />
                    <InterventionBox project={project} onError={setError} />
                  </>
                )}
                {tab === "document" && (
                  <>
                    <div className="sectionHeading">
                      <div>
                        <h2>공동 문서</h2>
                        <p className="help">
                          두 모델이 번갈아 고친 버전을 모두 보관합니다. 버전을 눌러 무엇이 바뀌었는지
                          확인하세요.
                        </p>
                      </div>
                      <span>{project.documents?.length ?? 0}개 버전</span>
                    </div>
                    <DocumentPanel project={project} />
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
                        <RichMarkdown>{project.report}</RichMarkdown>
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
            우리의장난감 <span>GPT와 Claude가 함께 쓰는 연구 노트</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
