import { describe, expect, it } from "vitest";
import { cleanAgentOutput } from "./server";

describe("cleanAgentOutput", () => {
  it("keeps an ordinary answer as it is", () => {
    expect(cleanAgentOutput("  Improve the login flow.\n")).toBe(
      "Improve the login flow.",
    );
  });

  it("unwraps a fenced answer", () => {
    expect(cleanAgentOutput("```markdown\nRun the tests.\n```")).toBe(
      "Run the tests.",
    );
  });

  it("unwraps a quoted answer", () => {
    expect(cleanAgentOutput('"Run the tests."')).toBe("Run the tests.");
  });

  it("leaves quotes that belong to the prompt", () => {
    expect(cleanAgentOutput('Rename the "login" button to "sign in".')).toBe(
      'Rename the "login" button to "sign in".',
    );
  });

  it("keeps fenced code inside a longer answer", () => {
    const answer = "Fix this snippet:\n\n```ts\nconst a = 1;\n```\n\nand explain why.";
    expect(cleanAgentOutput(answer)).toBe(answer);
  });
});
