/**
 * Model catalogue shapes and the search rules of the prompt input's own model
 * picker, so the plugin's picker filters the way that one does.
 */

/** The agent a re-phrase runs on, or null for the prompt input's own agent. */
export interface AgentSelection {
  providerId: string;
  model: string;
}

/** One selectable model row. */
export interface ModelChoice {
  providerId: string;
  /** Provider display name, rendered as the group heading. */
  providerName: string;
  model: string;
  /** Row label: the catalogue's display name without its brand prefix. */
  label: string;
  description: string;
  /**
   * Listed only while searching. The prompt input hides these behind "More
   * models" until a query is typed, and so does this picker.
   */
  extra: boolean;
}

/**
 * Drop the brand prefix from a model label, the way the prompt input does once
 * the provider is already named beside the model.
 */
export function stripModelBrandPrefix(
  label: string,
  providerId: string,
): string {
  if (providerId.startsWith("claude")) return label.replace(/^Claude\s+/i, "");
  if (providerId.startsWith("codex")) return label.replace(/^GPT-/i, "");
  return label;
}

/**
 * A loose fuzzy matcher: every character of the query has to appear in order,
 * so "gpt4" matches "GPT-4 Turbo".
 */
export function buildFuzzyRegex(query: string): RegExp {
  const pattern = query
    .split("")
    .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(pattern, "i");
}

/**
 * The models to list for a query: the default ones while the search box is
 * empty, every fuzzy match — including the ones normally kept behind "More
 * models" — once something is typed.
 */
export function filterModelChoices(
  choices: readonly ModelChoice[],
  query: string,
): ModelChoice[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return choices.filter((choice) => !choice.extra);
  const regex = buildFuzzyRegex(normalized);
  return choices.filter((choice) =>
    regex.test(`${choice.label} ${choice.model} ${choice.providerName}`),
  );
}

/**
 * The listed choices, plus a row for a picked model the catalogue no longer
 * offers — a provider that stopped reporting models would otherwise show
 * nothing selected while re-phrase kept using it.
 */
export function withSelectionChoice(
  choices: readonly ModelChoice[],
  selection: AgentSelection | null,
): ModelChoice[] {
  if (selection === null) return [...choices];
  const known = choices.some(
    (choice) =>
      choice.providerId === selection.providerId &&
      choice.model === selection.model,
  );
  if (known) return [...choices];
  return [
    {
      providerId: selection.providerId,
      providerName: selection.providerId,
      model: selection.model,
      label: selection.model,
      description: "Picked earlier; this agent is not listing models now.",
      extra: false,
    },
    ...choices,
  ];
}

/** The listed models grouped under their provider, in catalogue order. */
export function groupChoicesByProvider(
  choices: readonly ModelChoice[],
): { providerId: string; providerName: string; choices: ModelChoice[] }[] {
  const groups: {
    providerId: string;
    providerName: string;
    choices: ModelChoice[];
  }[] = [];
  for (const choice of choices) {
    const group = groups.find((entry) => entry.providerId === choice.providerId);
    if (group) {
      group.choices.push(choice);
      continue;
    }
    groups.push({
      providerId: choice.providerId,
      providerName: choice.providerName,
      choices: [choice],
    });
  }
  return groups;
}
