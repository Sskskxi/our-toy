import type { Actor, Project } from "./types";

export type ActorUsage = {
  actor: Actor;
  completedCalls: number;
  runningCalls: number;
  failedCalls: number;
  tokens: number;
  models: string[];
};

export function projectUsage(project: Project): Record<Actor, ActorUsage> {
  return Object.fromEntries(
    (["GPT", "Claude"] as const).map((actor) => {
      const calls = project.calls.filter((call) => call.actor === actor);
      return [
        actor,
        {
          actor,
          completedCalls: calls.filter((call) => call.status === "complete")
            .length,
          runningCalls: calls.filter((call) => call.status === "running")
            .length,
          failedCalls: calls.filter((call) => call.status === "failed").length,
          tokens: calls.reduce(
            (total, call) => total + (call.result?.tokens ?? 0),
            0,
          ),
          models: [
            ...new Set(
              calls.flatMap((call) =>
                call.result?.model ? [call.result.model] : [],
              ),
            ),
          ],
        },
      ];
    }),
  ) as Record<Actor, ActorUsage>;
}
