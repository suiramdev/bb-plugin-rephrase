import { describe, expect, it } from "vitest";
import {
  filterModelChoices,
  groupChoicesByProvider,
  stripModelBrandPrefix,
  withSelectionChoice,
  type ModelChoice,
} from "./lib/models";

function choice(
  overrides: Partial<ModelChoice> & Pick<ModelChoice, "model" | "label">,
): ModelChoice {
  return {
    providerId: "claude-code",
    providerName: "Claude Code",
    description: "",
    extra: false,
    ...overrides,
  };
}

const SONNET = choice({ model: "claude-sonnet-4-6", label: "Sonnet 4.6" });
const HAIKU = choice({
  model: "claude-haiku-4-5",
  label: "Haiku 4.5",
  extra: true,
});
const GPT = choice({
  providerId: "codex",
  providerName: "Codex",
  model: "gpt-5.5",
  label: "5.5",
});

describe("stripModelBrandPrefix", () => {
  it("drops the brand the provider heading already states", () => {
    expect(stripModelBrandPrefix("Claude Sonnet 4.6", "claude-code")).toBe(
      "Sonnet 4.6",
    );
    expect(stripModelBrandPrefix("GPT-5.5", "codex")).toBe("5.5");
    expect(stripModelBrandPrefix("Gemini 3 Pro", "gemini")).toBe("Gemini 3 Pro");
  });
});

describe("filterModelChoices", () => {
  it("lists the default models while the search box is empty", () => {
    expect(filterModelChoices([SONNET, HAIKU, GPT], "")).toEqual([SONNET, GPT]);
    expect(filterModelChoices([SONNET, HAIKU, GPT], "   ")).toEqual([
      SONNET,
      GPT,
    ]);
  });

  it("reaches the models hidden from the default list once something is typed", () => {
    expect(filterModelChoices([SONNET, HAIKU, GPT], "haiku")).toEqual([HAIKU]);
  });

  it("matches loosely, in order, like the prompt input", () => {
    expect(filterModelChoices([SONNET, HAIKU, GPT], "gpt55")).toEqual([GPT]);
    expect(filterModelChoices([SONNET, HAIKU, GPT], "son46")).toEqual([SONNET]);
    // Order matters: the characters have to appear left to right.
    expect(filterModelChoices([SONNET, HAIKU, GPT], "6.4")).toEqual([]);
  });

  it("matches the model id and the agent name, not just the label", () => {
    expect(filterModelChoices([SONNET, HAIKU, GPT], "codex")).toEqual([GPT]);
    expect(filterModelChoices([SONNET, HAIKU, GPT], "claude-sonnet")).toEqual([
      SONNET,
    ]);
  });

  it("treats a query with regex characters as text", () => {
    expect(filterModelChoices([SONNET, GPT], "5.5")).toEqual([GPT]);
    expect(filterModelChoices([SONNET, GPT], "(")).toEqual([]);
  });
});

describe("withSelectionChoice", () => {
  it("leaves the list alone when the pick is listed", () => {
    expect(
      withSelectionChoice([SONNET, GPT], {
        providerId: "codex",
        model: "gpt-5.5",
      }),
    ).toEqual([SONNET, GPT]);
  });

  it("adds a row for a pick the catalogue no longer offers", () => {
    const listed = withSelectionChoice([SONNET], {
      providerId: "codex",
      model: "gpt-legacy",
    });
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      providerId: "codex",
      model: "gpt-legacy",
      label: "gpt-legacy",
      extra: false,
    });
  });
});

describe("groupChoicesByProvider", () => {
  it("keeps catalogue order and groups each agent once", () => {
    expect(
      groupChoicesByProvider([GPT, SONNET, HAIKU]).map((group) => [
        group.providerName,
        group.choices.map((entry) => entry.model),
      ]),
    ).toEqual([
      ["Codex", ["gpt-5.5"]],
      ["Claude Code", ["claude-sonnet-4-6", "claude-haiku-4-5"]],
    ]);
  });
});
