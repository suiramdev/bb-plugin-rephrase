// bb-plugin-rephrase — backend entry.
//
// The composer action posts the current draft here; this file runs it through
// an agent in a throwaway hidden thread and returns the rewritten prompt.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  stripModelBrandPrefix,
  type AgentSelection,
  type ModelChoice,
} from "./lib/models";

/** Instruction sent with the draft when the setting is left empty. */
export const DEFAULT_INSTRUCTION = [
  "Rewrite the prompt below so it is clearer and more effective for a coding agent.",
  "",
  "Rules:",
  "- Keep the author's intent, constraints and tone. Never invent requirements, facts, file names or acceptance criteria.",
  "- Preserve every concrete detail exactly as written: paths, identifiers, code, URLs, @-mentions and /commands.",
  "- Make the request specific and unambiguous: the goal, the scope, and what a good result looks like.",
  "- Prefer short paragraphs or bullets. Remove filler, hedging and repetition.",
  "- Keep the language the prompt is written in.",
  "- Do not answer the prompt, do not do the work it asks for, and do not ask questions.",
  "- Do not read files, run commands or use any tool.",
  "",
  "Reply with the rewritten prompt only: no preamble, no commentary, no surrounding quotes or code fences.",
].join("\n");

/** kv key holding the chosen agent; absent means the composer's own agent. */
const SELECTION_KEY = "agent-selection";

/** How long a discovered model catalogue is reused. */
const CATALOG_TTL_MS = 60_000;

const TIMEOUT_OPTIONS: Record<string, number> = {
  "30 seconds": 30_000,
  "1 minute": 60_000,
  "2 minutes": 120_000,
  "5 minutes": 300_000,
};
const DEFAULT_TIMEOUT_OPTION = "2 minutes";

type PermissionMode = "auto" | "accept-edits" | "full";

/** Least to most privileged; the first one a provider supports is used. */
const PERMISSION_MODE_PREFERENCE: readonly PermissionMode[] = [
  "auto",
  "accept-edits",
  "full",
];

/**
 * The composer scope the draft came from, mirrored from the frontend's
 * `PluginComposerScope`. It tells us which project the rephrase runs in and,
 * for thread-backed composers, which agent the user has selected there.
 */
const composerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string() }),
  z.object({ kind: z.literal("queued-message"), threadId: z.string() }),
  z.object({
    kind: z.literal("side-chat"),
    projectId: z.string(),
    parentThreadId: z.string(),
  }),
  z.object({
    kind: z.literal("new-thread"),
    projectId: z.string().nullable(),
  }),
]);

/** Composer scope a rephrase request came from. */
export type ComposerScope = z.infer<typeof composerScopeSchema>;

const agentSelectionSchema: z.ZodType<AgentSelection, AgentSelection> = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});

const modelChoiceSchema: z.ZodType<ModelChoice, ModelChoice> = z.object({
  providerId: z.string(),
  providerName: z.string(),
  model: z.string(),
  label: z.string(),
  description: z.string(),
  extra: z.boolean(),
});

export const rpcContract = defineRpcContract({
  rephrase: {
    input: z
      .object({ text: z.string().min(1), scope: composerScopeSchema })
      .strict(),
    output: z.union([
      z.object({ ok: z.literal(true), text: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  catalog: {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: z.object({
      selection: agentSelectionSchema.nullable(),
      choices: z.array(modelChoiceSchema),
      unavailable: z.array(z.string()),
    }),
  },
  selectAgent: {
    input: z.object({ selection: agentSelectionSchema.nullable() }).strict(),
    output: z.object({ selection: agentSelectionSchema.nullable() }),
  },
});

/** Payload the composer sends to the `rephrase` method. */
export interface RephraseInput {
  text: string;
  scope: ComposerScope;
}

/** Answer of the `rephrase` method: the rewritten draft, or why there is none. */
export type RephraseResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Where and with which agent the throwaway rephrase thread should run. */
interface RephraseTarget {
  projectId: string;
  providerId?: string;
  model?: string;
  environmentId: string | null;
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    instruction: {
      type: "string",
      label: "Re-phrase instruction",
      description:
        "Instruction sent to the agent together with your draft. Clear it to restore the built-in instruction.",
      default: DEFAULT_INSTRUCTION,
    },
    timeout: {
      type: "select",
      label: "Timeout",
      description: "How long to wait for the agent before giving up.",
      options: Object.keys(TIMEOUT_OPTIONS),
      default: DEFAULT_TIMEOUT_OPTION,
    },
  });
  const catalog = createCatalogCache(bb);

  bb.rpc.register(rpcContract, {
    async rephrase({ text, scope }): Promise<RephraseResult> {
      const { instruction, timeout } = await settings.get();
      const timeoutMs =
        TIMEOUT_OPTIONS[timeout] ?? TIMEOUT_OPTIONS[DEFAULT_TIMEOUT_OPTION]!;
      const selection =
        (await bb.storage.kv.get<AgentSelection>(SELECTION_KEY)) ?? null;

      let target: RephraseTarget;
      try {
        target = await resolveTarget(bb, scope, selection);
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }

      const prompt = buildPrompt(instruction.trim() || DEFAULT_INSTRUCTION, text);
      try {
        const output = await runRephraseThread(bb, target, prompt, timeoutMs);
        const rewritten = cleanAgentOutput(output ?? "");
        if (rewritten === "") {
          return { ok: false, error: "The agent returned an empty answer." };
        }
        return { ok: true, text: rewritten };
      } catch (error) {
        const message = describeError(error);
        bb.log.warn(`re-phrase failed: ${message}`);
        return { ok: false, error: message };
      }
    },

    async catalog({ refresh }) {
      const { choices, unavailable } = await catalog.read(refresh);
      return {
        selection: (await bb.storage.kv.get<AgentSelection>(SELECTION_KEY)) ?? null,
        choices,
        unavailable,
      };
    },

    async selectAgent({ selection }) {
      if (selection === null) {
        await bb.storage.kv.delete(SELECTION_KEY);
      } else {
        await bb.storage.kv.set(SELECTION_KEY, selection);
      }
      return { selection };
    },
  });
}

/** Every model of every available provider, plus the providers that failed. */
interface ModelCatalog {
  choices: ModelChoice[];
  unavailable: string[];
}

/**
 * Discovery asks each provider for its models, which can mean launching that
 * provider's CLI, so a catalogue is reused for a minute and concurrent readers
 * share one in-flight discovery.
 */
function createCatalogCache(bb: BbPluginApi) {
  let cached: { at: number; catalog: Promise<ModelCatalog> } | null = null;
  return {
    read(refresh: boolean): Promise<ModelCatalog> {
      const fresh =
        cached !== null && Date.now() - cached.at < CATALOG_TTL_MS && !refresh;
      if (!fresh) {
        const pending = discoverModels(bb);
        cached = { at: Date.now(), catalog: pending };
        // A failed discovery must not be cached as the answer for a minute.
        pending.catch(() => {
          if (cached?.catalog === pending) cached = null;
        });
      }
      return cached!.catalog;
    },
  };
}

async function discoverModels(bb: BbPluginApi): Promise<ModelCatalog> {
  const providers = (await bb.sdk.providers.list()).filter(
    (provider) => provider.available,
  );
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        return {
          provider,
          options: await bb.sdk.providers.models({ providerId: provider.id }),
        };
      } catch (error) {
        bb.log.debug(`no models for ${provider.id}: ${describeError(error)}`);
        return { provider, options: null };
      }
    }),
  );

  const choices: ModelChoice[] = [];
  const unavailable: string[] = [];
  for (const { provider, options } of results) {
    // A provider whose CLI is missing or unauthenticated reports its failure
    // instead of a catalogue; name it rather than dropping it silently.
    if (options === null || options.modelLoadError !== null) {
      unavailable.push(provider.displayName);
      continue;
    }
    const toChoice = (
      entry: { model: string; displayName: string; description: string },
      extra: boolean,
    ): ModelChoice => ({
      providerId: provider.id,
      providerName: provider.displayName,
      model: entry.model,
      label: stripModelBrandPrefix(entry.displayName, provider.id),
      description: entry.description,
      extra,
    });
    for (const entry of options.models) choices.push(toChoice(entry, false));
    for (const entry of options.selectedOnlyModels) {
      if (options.models.some((listed) => listed.model === entry.model)) continue;
      choices.push(toChoice(entry, true));
    }
  }
  return { choices, unavailable };
}

/**
 * Resolve the project, agent and environment for a rephrase.
 *
 * Without a picked agent the composer's own context supplies it: the thread's
 * provider and model for a thread-backed draft, the project's execution
 * defaults for the root compose screen.
 */
async function resolveTarget(
  bb: BbPluginApi,
  scope: ComposerScope,
  selection: AgentSelection | null,
): Promise<RephraseTarget> {
  if (scope.kind === "new-thread") {
    if (scope.projectId === null) {
      throw new Error("Pick a project in the composer first.");
    }
    const projectId = scope.projectId;
    // The root composer's own picker is not readable from a plugin, so the
    // project's remembered defaults — what that picker is seeded with — stand
    // in for "the agent currently selected".
    const defaults = await bb.sdk.projects
      .defaultExecutionOptions({ projectId })
      .catch(() => null);
    return {
      projectId,
      environmentId: await latestEnvironmentId(bb, projectId),
      ...(selection ??
        (defaults
          ? { providerId: defaults.providerId, model: defaults.model }
          : {})),
    };
  }

  const threadId =
    scope.kind === "side-chat" ? scope.parentThreadId : scope.threadId;
  const thread = await bb.sdk.threads.get({ threadId });
  const execution = await bb.sdk.threads
    .defaultExecutionOptions({ threadId })
    .catch(() => null);
  return {
    projectId: thread.projectId,
    environmentId: thread.environmentId,
    ...(selection ?? {
      providerId: thread.providerId,
      ...(execution ? { model: execution.model } : {}),
    }),
  };
}

/**
 * An environment already provisioned in the project, so a rephrase started
 * from the root composer does not create a worktree of its own.
 */
async function latestEnvironmentId(
  bb: BbPluginApi,
  projectId: string,
): Promise<string | null> {
  const threads = await bb.sdk.threads
    .list({ projectId, limit: 20 })
    .catch(() => []);
  return threads.find((thread) => thread.environmentId)?.environmentId ?? null;
}

/**
 * The most restrictive permission mode the target agent supports. Rewriting a
 * prompt needs no tools at all, and providers reject a mode they do not
 * implement, so the mode is narrowed per provider instead of hardcoded.
 */
async function restrictedPermissionMode(
  bb: BbPluginApi,
  providerId: string | undefined,
): Promise<PermissionMode | null> {
  if (providerId === undefined) return null;
  const providers = await bb.sdk.providers.list().catch(() => []);
  const supported = providers.find((provider) => provider.id === providerId)
    ?.capabilities.supportedPermissionModes;
  if (supported === undefined) return null;
  return (
    PERMISSION_MODE_PREFERENCE.find((mode) => supported.includes(mode)) ?? null
  );
}

function buildPrompt(instruction: string, text: string): string {
  return [
    instruction,
    "",
    "--- PROMPT TO REWRITE ---",
    text,
    "--- END OF PROMPT ---",
  ].join("\n");
}

/**
 * Run the prompt in a hidden thread and return its answer. The thread is
 * archived and stopped on every path so a rephrase never leaves an agent
 * runtime behind.
 */
async function runRephraseThread(
  bb: BbPluginApi,
  target: RephraseTarget,
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  const permissionMode = await restrictedPermissionMode(bb, target.providerId);
  const worker = await bb.sdk.threads.spawn({
    projectId: target.projectId,
    environment:
      target.environmentId === null
        ? { type: "project-default" }
        : { type: "reuse", environmentId: target.environmentId },
    prompt,
    title: "Re-phrase prompt",
    visibility: "hidden",
    ...(target.providerId ? { providerId: target.providerId } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    // Without provenance the server drops a requested provider/model and
    // re-derives both from the project defaults.
    executionInputSources: {
      ...(target.providerId ? { providerId: "explicit" as const } : {}),
      ...(target.model ? { model: "explicit" as const } : {}),
      ...(permissionMode ? { permissionMode: "explicit" as const } : {}),
    },
  });

  try {
    // `turn/completed` is matched from the thread's first event, so this is
    // safe whether the turn finishes before or after the wait starts.
    let completed;
    try {
      completed = await bb.sdk.threads.wait({
        threadId: worker.id,
        event: "turn/completed",
        timeoutMs,
      });
    } catch (error) {
      const thread = await bb.sdk.threads
        .get({ threadId: worker.id })
        .catch(() => null);
      throw thread?.status === "error"
        ? new Error("The agent stopped with an error.")
        : new Error(
            `The agent did not answer within ${Math.round(timeoutMs / 1000)}s (${describeError(error)}).`,
          );
    }

    // The turn can complete without answering — a provider that fails or is
    // interrupted says so here, and its message beats an empty answer.
    const event = "event" in completed ? completed.event : null;
    if (event?.type === "turn/completed" && event.data.status !== "completed") {
      const detail = event.data.error?.message;
      throw new Error(
        detail !== undefined
          ? `The agent failed: ${detail}`
          : event.data.status === "interrupted"
            ? "The agent was interrupted."
            : "The agent stopped without answering.",
      );
    }

    const { output } = await bb.sdk.threads.output({ threadId: worker.id });
    return output;
  } finally {
    // Release the agent runtime first, then drop the throwaway thread so a
    // busy composer does not leave a trail of hidden threads behind.
    await bb.sdk.threads
      .stop({ threadId: worker.id })
      .catch((error: unknown) =>
        bb.log.warn(`could not stop ${worker.id}: ${describeError(error)}`),
      );
    await bb.sdk.threads
      .delete({ threadId: worker.id, childThreadsConfirmed: true })
      .catch(async (error: unknown) => {
        bb.log.warn(`could not delete ${worker.id}: ${describeError(error)}`);
        await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
      });
  }
}

/**
 * Agents like to dress an answer up. Strip the wrapping the instruction asks
 * them to leave out rather than pasting it into the composer.
 */
export function cleanAgentOutput(output: string): string {
  let text = output.trim();

  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/;
  const fenced = fence.exec(text);
  if (fenced) text = fenced[1]!.trim();

  const quoted = /^"([\s\S]+)"$/.exec(text) ?? /^'([\s\S]+)'$/.exec(text);
  if (quoted && !quoted[1]!.includes('"')) text = quoted[1]!.trim();

  return text;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
