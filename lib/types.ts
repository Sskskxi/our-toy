import { z } from "zod";
export const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const modelChoiceSchema = z.object({
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,79}$/, "모델 ID 형식이 올바르지 않습니다.")
    .optional(),
  effort: z.enum(efforts).optional(),
});
export const modelsSchema = z
  .object({ GPT: modelChoiceSchema.optional(), Claude: modelChoiceSchema.optional() })
  .refine((v) => v.GPT?.effort !== "max", {
    message: "GPT 추론 강도는 xhigh까지 선택할 수 있습니다.",
  });
export type ModelChoices = z.infer<typeof modelsSchema>;
export const interventionSchema = z.object({
  text: z.string().trim().min(1, "개입 내용을 입력하세요.").max(4000),
  target: z.enum(["GPT", "Claude", "both"]).default("both"),
});
export type Intervention = z.infer<typeof interventionSchema> & {
  id: string;
  createdAt: string;
  /** First delivery; kept for display and older records. */
  appliedAt?: string;
  appliedRound?: number;
  appliedStage?: Stage;
  /** Per-model deliveries: a note for both models may reach them at different stages. */
  deliveries?: { actor: Actor; stage: Stage; round: number; at: string }[];
  /** The run ended before every target model received the note. */
  expired?: boolean;
};
export const inputSchema = z
  .object({
    models: modelsSchema.optional(),
    referenceText: z.string().max(20000).optional(),
    attachments: z.array(z.object({
      name: z.string().min(1).max(200).regex(/\.(pdf|txt|md|csv|json|log)$/i),
      text: z.string().min(1).max(40000).refine(v => !v.includes("\u0000")),
    })).max(5).optional(),
    topic: z.string().trim().min(5).max(2000),
    mode: z.enum(["mock", "subscription"]).default("mock"),
    strategy: z.enum(["codraft", "debate"]).default("codraft"),
    maxRounds: z.number().int().min(1).max(30).default(8),
    minRounds: z.number().int().min(1).max(30).optional(),
    noveltyThreshold: z.number().min(0).max(1).default(0.12),
  })
  .refine(v => (v.referenceText?.length ?? 0) + (v.attachments ?? []).reduce((n, f) => n + f.text.length, 0) <= 60000, {
    message: "참고 자료는 합계 60,000자까지 가능합니다.",
  })
  .refine((v) => v.minRounds === undefined || v.minRounds <= v.maxRounds, {
    message: "최소 라운드는 최대 라운드 이하여야 합니다.",
  });
export type Input = z.infer<typeof inputSchema>;
export type InputRaw = z.input<typeof inputSchema>;
export type Actor = "GPT" | "Claude";
export type Stage =
  | "plan"
  | "draft"
  | "merge"
  | "revise"
  | "research"
  | "critique"
  | "rebuttal"
  | "synthesis"
  | "conversation"
  | "conversation-synthesis";
/** Stages allowed to use web search when ENABLE_WEB_SEARCH is on. */
export const SEARCH_STAGES: Stage[] = ["research", "draft", "revise", "conversation"];
export const messageSchema = z.object({
  message: z.string().trim().min(1, "메시지를 입력하세요.").max(10000),
  target: z.enum(["GPT", "Claude", "both"]),
  models: modelsSchema.optional(),
});
export type MessageInput = z.infer<typeof messageSchema>;
const sourceSchema = z.object({
  url: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//.test(v)),
  title: z.string().max(500),
  excerpt: z.string().max(2000),
});
export const answerSchema = z.object({
  questions: z.array(z.string().min(1).max(1000)).max(12),
  claims: z
    .array(
      z.object({
        statement: z.string().min(1).max(3000),
        sources: z.array(sourceSchema).max(8),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(12),
  critiques: z
    .array(
      z.object({
        claim: z.string().max(3000),
        objection: z.string().max(3000),
      }),
    )
    .max(12),
  unresolved: z.array(z.string().min(1).max(1000)).max(12),
  resolved: z.array(z.string().min(1).max(1000)).max(12),
  summary: z.string().max(24000),
});
export type Answer = z.infer<typeof answerSchema>;
export type Result = {
  answer: Answer;
  observedUrls: string[];
  tokens: number;
  model: string;
  sessionId?: string;
};
export type Evidence = Answer["claims"][number]["sources"][number] & {
  provenance: "mock" | "provider-cited" | "unverified";
};
export type Claim = {
  id: string;
  statement: string;
  confidence: number;
  actors: Actor[];
  sources: Evidence[];
  status: "needs-evidence" | "contested" | "source-linked";
  objections: string[];
  rounds: number[];
};
export type Call = {
  actor: Actor;
  stage: Stage;
  round: number;
  status: "running" | "complete" | "failed";
  startedAt: string;
  finishedAt?: string;
  result?: Result;
  error?: string;
  /** Result reused from a checkpoint when an interrupted run resumed. */
  replayed?: boolean;
};
export type DocumentVersion = {
  version: number;
  author: Actor;
  stage: Stage;
  round: number;
  markdown: string;
  changes: { target: string; reason: string }[];
  openIssues: string[];
  createdAt: string;
};
export type Round = {
  number: number;
  questions: string[];
  novelty?: number;
  newItems?: number;
  requeued: string[];
};
export type ConversationTurn = {
  id: string;
  target: MessageInput["target"];
  userText: string;
  status: "queued" | "running" | "complete" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  models?: ModelChoices;
  responses: Partial<Record<Actor, Result>>;
  synthesis?: Result;
  answer?: string;
  error?: string;
};
export type Conversation = {
  id: string;
  createdAt: string;
  memory: string;
  turns: ConversationTurn[];
};
export type Project = Omit<Input, "mode" | "strategy"> & {
  mode: "mock" | "subscription" | "live";
  /** Display name set by the user; the research topic stays unchanged. */
  title?: string;
  /** Missing on projects created before shared drafts existed: those are debates. */
  strategy?: "codraft" | "debate";
  documents?: DocumentVersion[];
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "queued" | "running" | "complete" | "failed" | "interrupted";
  stage: string;
  calls: Call[];
  rounds: Round[];
  claims: Claim[];
  questions: string[];
  unresolved: string[];
  stopReason?: string;
  report?: string;
  error?: string;
  tokens: number;
  providerSessions: Partial<Record<Actor, string>>;
  conversation: Conversation;
  interventions?: Intervention[];
};
export type Request = {
  actor: Actor;
  stage: Stage;
  round: number;
  topic: string;
  questions: string[];
  context: unknown;
  mode: "mock" | "subscription" | "live";
  projectId?: string;
  sessionId?: string;
  model?: string;
  effort?: string;
};
export type Provider = (request: Request) => Promise<Result>;
