// bb-plugin-rephrase — frontend entry.
//
// Adds a "Re-phrase" button to the prompt input. Clicking it sends the current
// draft to an agent and writes the rewritten prompt back into the composer.
import { useState } from "react";
import {
  definePluginApp,
  useComposer,
  useComposerView,
  useRpc,
  type ComposerView,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  ComposerScope,
  RephraseInput,
  RephraseResult,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Icon } from "@/components/ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./app.css";

const PLUGIN_ID = "rephrase";
const ACTION_LABEL = "Re-phrase prompt";

type RephraseCall = (input: RephraseInput) => Promise<RephraseResult>;

/**
 * The plugin-visible part of the composer scope. The backend needs the thread
 * (to read the agent selected there) or the project (on the compose screen).
 */
function toRpcScope(scope: ComposerView["scope"]): ComposerScope {
  switch (scope.kind) {
    case "thread":
    case "queued-message":
      return { kind: scope.kind, threadId: scope.threadId };
    case "side-chat":
      return {
        kind: "side-chat",
        projectId: scope.projectId,
        parentThreadId: scope.parentThreadId,
      };
    case "new-thread":
      return { kind: "new-thread", projectId: scope.projectId };
  }
}

/**
 * Replace the draft with its rephrased version, keeping the composer locked
 * while the agent works and offering the original text back afterwards.
 */
async function rephraseDraft(
  call: RephraseCall,
  composer: PluginComposerApi,
  view: ComposerView,
): Promise<void> {
  const original = composer.text;
  if (original.trim() === "") {
    toast.error("Nothing to re-phrase", {
      description: "Type a prompt first.",
    });
    return;
  }

  composer.setInputLock(true);
  composer.setTextEffect({ className: "rephrase-pending" });
  try {
    const result = await call({
      text: original,
      scope: toRpcScope(view.scope),
    });
    if (!result.ok) {
      toast.error("Re-phrase failed", { description: result.error });
      return;
    }
    if (result.text === original) {
      toast.info("That prompt is already clear", {
        description: "The agent left it unchanged.",
      });
      return;
    }
    composer.setInputLock(false);
    composer.setText(result.text);
    composer.focus();
    toast.success("Prompt re-phrased", {
      action: {
        label: "Undo",
        onClick: () => {
          composer.setText(original);
          composer.focus();
        },
      },
    });
  } catch (error) {
    toast.error("Re-phrase failed", {
      description: error instanceof Error ? error.message : String(error),
    });
  } finally {
    composer.setInputLock(false);
    composer.setTextEffect(null);
  }
}

function RephraseAction() {
  const composer = useComposer();
  const view = useComposerView();
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);

  async function run() {
    if (pending) return;
    setPending(true);
    try {
      await rephraseDraft(
        (input) => rpc.call("rephrase", input),
        composer,
        view,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={ACTION_LABEL}
            className={cn(COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS, "shrink-0")}
            disabled={pending || view.draft.isEmpty || view.run.isSubmitting}
            onClick={() => void run()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Icon
              aria-hidden
              className={cn("size-4", pending && "animate-spin")}
              name={pending ? "Spinner" : "AiContentGenerator01"}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {pending ? "Re-phrasing…" : ACTION_LABEL}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The `+` menu row is host-rendered, so it has no React context to hook into.
 * It posts to the same endpoint `useRpc` posts to — a same-origin request the
 * bb app authenticates the same way.
 */
const callRephraseOverHttp: RephraseCall = async (input) => {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/rephrase`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: RephraseResult;
    error?: { message?: string } | string;
  } | null;
  if (!response.ok || body?.ok !== true || body.result === undefined) {
    const error = body?.error;
    throw new Error(
      typeof error === "string"
        ? error
        : (error?.message ?? `Re-phrase failed (HTTP ${response.status})`),
    );
  }
  return body.result;
};

export default definePluginApp((app) => {
  app.composer.customize({
    id: "rephrase",
    actions: [{ id: "rephrase", component: RephraseAction }],
    // Composer actions are not rendered in the compact layout; the `+` menu is
    // available everywhere, so the same command lives there too.
    plusMenu: [
      {
        id: "rephrase",
        label: ACTION_LABEL,
        icon: "AiContentGenerator01",
        description: "Rewrite the current draft into a clearer prompt.",
        disabled: (view) => view.draft.isEmpty || view.run.isSubmitting,
        run: ({ composer, view }) =>
          rephraseDraft(callRephraseOverHttp, composer, view),
      },
    ],
  });
});
