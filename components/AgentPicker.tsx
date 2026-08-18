// The plugin's own model picker: a search box over the model catalogue that
// filters the way the prompt input's picker does.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import {
  filterModelChoices,
  groupChoicesByProvider,
  withSelectionChoice,
  type AgentSelection,
  type ModelChoice,
} from "../lib/models";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Catalog {
  selection: AgentSelection | null;
  choices: ModelChoice[];
  unavailable: string[];
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: Catalog };

export function AgentPicker() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setState({ status: "loading" });
      try {
        setState({
          status: "ready",
          catalog: await rpc.call("catalog", { refresh }),
        });
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [rpc],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  if (state.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon aria-hidden className="size-4 animate-spin" name="Spinner" />
        Loading models…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{state.message}</p>
        <Button onClick={() => void load(true)} size="sm" variant="outline">
          Try again
        </Button>
      </div>
    );
  }

  const catalog = state.catalog;
  const { selection, choices, unavailable } = catalog;
  const listed = filterModelChoices(
    withSelectionChoice(choices, selection),
    query,
  );
  const groups = groupChoicesByProvider(listed);

  async function select(next: AgentSelection | null) {
    setSaving(true);
    try {
      const saved = await rpc.call("selectAgent", { selection: next });
      setState({
        status: "ready",
        catalog: { ...catalog, selection: saved.selection },
      });
      toast.success(
        next === null
          ? "Re-phrase follows the prompt input's agent"
          : `Re-phrase uses ${next.model}`,
      );
    } catch (error) {
      toast.error("Could not save the agent", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <ChoiceRow
        description="Whatever the prompt input you click from is set to."
        disabled={saving}
        label="The agent selected in the prompt input"
        onSelect={() => void select(null)}
        selected={selection === null}
      />

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Icon
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            name="Search"
          />
          <Input
            aria-label="Search models"
            className="pl-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            value={query}
          />
        </div>
        <Button
          aria-label="Reload models"
          onClick={() => void load(true)}
          size="icon"
          variant="ghost"
        >
          <Icon aria-hidden className="size-4" name="RotateCcw" />
        </Button>
      </div>

      <div className="max-h-80 space-y-3 overflow-y-auto">
        {groups.map((group) => (
          <div className="space-y-0.5" key={group.providerId}>
            <p className="px-2 text-xs font-medium text-muted-foreground">
              {group.providerName}
            </p>
            {group.choices.map((choice) => (
              <ChoiceRow
                description={choice.description}
                disabled={saving}
                key={`${choice.providerId}/${choice.model}`}
                label={choice.label}
                onSelect={() =>
                  void select({
                    providerId: choice.providerId,
                    model: choice.model,
                  })
                }
                selected={
                  selection !== null &&
                  selection.providerId === choice.providerId &&
                  selection.model === choice.model
                }
              />
            ))}
          </div>
        ))}
        {groups.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No models match your search.
          </p>
        ) : null}
      </div>

      {unavailable.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          No models from {unavailable.join(", ")}. Sign in to those agents to
          pick one of their models.
        </p>
      ) : null}
    </div>
  );
}

function ChoiceRow({
  description,
  disabled,
  label,
  onSelect,
  selected,
}: {
  description: string;
  disabled: boolean;
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <Button
      aria-pressed={selected}
      className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
      disabled={disabled}
      onClick={onSelect}
      type="button"
      variant="ghost"
    >
      <Icon
        aria-hidden
        className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
        name="Check"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-normal">{label}</span>
        {description === "" ? null : (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </Button>
  );
}
