import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseDispatch,
  stripDispatch,
  parseDispatches,
  parsePipeline,
  stripPipeline,
  parseProject,
  parseRegisterProject,
  stripThink,
  applyProjectDirToPipelineSteps,
} from "../../lib/dispatch/parsers.mjs";

describe("parseDispatch", () => {
  test("parses structured @@DISPATCH marker", () => {
    const text = `@@DISPATCH {"agent":"crew-coder","task":"write hello.js"}`;
    const result = parseDispatch(text);
    assert.equal(result.agent, "crew-coder");
    assert.equal(result.task, "write hello.js");
  });

  test("returns null when no dispatch marker present", () => {
    assert.equal(parseDispatch("just a normal message"), null);
  });

  test("returns null when agent or task missing from JSON", () => {
    const text = `@@DISPATCH {"agent":"crew-coder"}`;
    assert.equal(parseDispatch(text), null);
  });

  test("strips <think> blocks before parsing", () => {
    const text = `<think>some reasoning</think>\n@@DISPATCH {"agent":"crew-qa","task":"audit code"}`;
    const result = parseDispatch(text);
    assert.equal(result.agent, "crew-qa");
  });

  test("preserves optional verify/done fields", () => {
    const text = `@@DISPATCH {"agent":"crew-coder","task":"write tests","verify":"tests pass","done":"CI green"}`;
    const result = parseDispatch(text);
    assert.equal(result.verify, "tests pass");
    assert.equal(result.done, "CI green");
  });

  test("returns null on invalid JSON in @@DISPATCH", () => {
    const text = `@@DISPATCH {broken json here`;
    assert.equal(parseDispatch(text), null);
  });
});

describe("parseDispatches", () => {
  test("parses multiple @@DISPATCH blocks", () => {
    const text = `
      @@DISPATCH {"agent":"crew-coder","task":"task 1"}
      @@DISPATCH {"agent":"crew-qa","task":"task 2"}
    `;
    const results = parseDispatches(text);
    assert.equal(results.length, 2);
    assert.equal(results[0].agent, "crew-coder");
    assert.equal(results[1].agent, "crew-qa");
  });

  test("returns empty array for empty/null input", () => {
    assert.deepEqual(parseDispatches(""), []);
    assert.deepEqual(parseDispatches(null), []);
  });

  test("ignores invalid JSON blocks", () => {
    const text = `@@DISPATCH {bad} @@DISPATCH {"agent":"crew-pm","task":"plan"}`;
    const results = parseDispatches(text);
    assert.equal(results.length, 1);
    assert.equal(results[0].agent, "crew-pm");
  });
});

describe("stripDispatch", () => {
  test("removes @@DISPATCH block from text", () => {
    const text = `Here is my plan.\n@@DISPATCH {"agent":"crew-coder","task":"write code"}\nDone.`;
    const result = stripDispatch(text);
    assert.ok(!result.includes("@@DISPATCH"));
    assert.ok(result.includes("Here is my plan."));
  });
});

describe("parsePipeline", () => {
  test("parses @@PIPELINE with wave numbers", () => {
    // crew-pm is auto-appended after coding agents, so 2 explicit waves → 3 total
    const text = `@@PIPELINE [{"wave":1,"agent":"crew-coder","task":"build"},{"wave":2,"agent":"crew-qa","task":"test"}]`;
    const result = parsePipeline(text);
    assert.ok(result !== null);
    assert.ok(result.waves.length >= 2, `expected >= 2 waves, got ${result.waves.length}`);
    assert.ok(result.steps.some(s => s.agent === "crew-coder"), "should contain crew-coder step");
    assert.ok(result.steps.some(s => s.agent === "crew-qa"), "should contain crew-qa step");
  });

  test("assigns sequential waves when wave field missing", () => {
    const text = `@@PIPELINE [{"agent":"crew-coder","task":"build"},{"agent":"crew-qa","task":"test"}]`;
    const result = parsePipeline(text);
    assert.ok(result !== null);
    assert.equal(result.steps[0].wave, 1);
    assert.equal(result.steps[1].wave, 2);
  });

  test("returns null for single-step array", () => {
    const text = `@@PIPELINE [{"wave":1,"agent":"crew-coder","task":"only one"}]`;
    assert.equal(parsePipeline(text), null);
  });

  test("returns null when no pipeline present", () => {
    assert.equal(parsePipeline("no pipeline here"), null);
  });

  test("auto-inserts crew-pm wave after coding agents", () => {
    const text = `@@PIPELINE [{"wave":1,"agent":"crew-coder","task":"code"},{"wave":2,"agent":"crew-qa","task":"test"}]`;
    const result = parsePipeline(text);
    assert.ok(result !== null);
    const hasPm = result.steps.some(s => s.agent === "crew-pm");
    assert.ok(hasPm, "crew-pm should be auto-appended");
  });
});

describe("applyProjectDirToPipelineSteps", () => {
  test("prefixes bare markdown filenames with projectDir", () => {
    const steps = [
      {
        agent: "crew-coder-front",
        task: "@@READ_FILE content-draft.md then @@READ_FILE seo-strategy.md",
      },
    ];
    applyProjectDirToPipelineSteps(steps, "/tmp/my-project");
    assert.match(steps[0].task, /\/tmp\/my-project\/content-draft\.md/);
    assert.match(steps[0].task, /\/tmp\/my-project\/seo-strategy\.md/);
  });

  test("does not rewrite paths that already include a directory", () => {
    const steps = [
      { agent: "crew-frontend", task: "@@READ_FILE docs/design-brief.md" },
    ];
    const before = steps[0].task;
    applyProjectDirToPipelineSteps(steps, "/tmp/my-project");
    assert.equal(steps[0].task, before);
  });

  test("no-op without projectDir", () => {
    const steps = [{ agent: "crew-coder", task: "@@READ_FILE foo.md" }];
    const before = steps[0].task;
    applyProjectDirToPipelineSteps(steps, null);
    assert.equal(steps[0].task, before);
  });
});

describe("stripPipeline", () => {
  test("removes @@PIPELINE block", () => {
    const text = `Plan:\n@@PIPELINE [{"wave":1,"agent":"crew-coder","task":"a"},{"wave":2,"agent":"crew-qa","task":"b"}]\nEnd.`;
    const result = stripPipeline(text);
    assert.ok(!result.includes("@@PIPELINE"));
  });
});

describe("parseProject", () => {
  test("parses @@PROJECT JSON", () => {
    const text = `@@PROJECT {"name":"myapp","outputDir":"/tmp/myapp"}`;
    const result = parseProject(text);
    assert.equal(result.name, "myapp");
    assert.equal(result.outputDir, "/tmp/myapp");
  });

  test("returns null if not present", () => {
    assert.equal(parseProject("no project here"), null);
  });
});

describe("parseRegisterProject", () => {
  test("parses @@REGISTER_PROJECT with name and outputDir", () => {
    const text = `@@REGISTER_PROJECT {"name":"Cool App","outputDir":"/tmp/cool","description":"A cool app"}`;
    const result = parseRegisterProject(text);
    assert.equal(result.name, "Cool App");
    assert.equal(result.outputDir, "/tmp/cool");
    assert.equal(result.description, "A cool app");
  });

  test("returns null when name or outputDir missing", () => {
    const text = `@@REGISTER_PROJECT {"name":"only name"}`;
    assert.equal(parseRegisterProject(text), null);
  });
});

describe("parseDispatch — natural language fallback", () => {
  test("parses imperative dispatch phrasing", () => {
    const text =
      "dispatch crew-coder build /Users/jeffhobbs/Desktop/Chuck/index.html from the planning docs";
    const result = parseDispatch(text, text);
    assert.ok(result !== null, "expected a dispatch result");
    assert.equal(result.agent, "crew-coder");
    assert.match(result.task, /build .*index\.html/);
  });

  test("normalizes profane crew-handle variants", () => {
    const text =
      "send fucking crew-coder build the landing page from the docs";
    const result = parseDispatch(text, text);
    assert.ok(result !== null, "expected a dispatch result");
    assert.equal(result.agent, "crew-coder");
    assert.match(result.task, /build the landing page/);
  });

  test("parses 'I'll dispatch to crew-coder' phrasing", () => {
    const text = "I'll dispatch to crew-coder to write the auth module.";
    const result = parseDispatch(text, "write the auth module");
    assert.ok(result !== null, "expected a dispatch result");
    assert.equal(result.agent, "crew-coder");
  });

  test("parses 'routing to crew-qa' phrasing", () => {
    const text = "Routing to crew-qa for a code audit.";
    const result = parseDispatch(text, "run a code audit");
    assert.ok(result !== null, "expected a dispatch result");
    assert.equal(result.agent, "crew-qa");
  });

  test("parses 'dispatching now to crew-fixer' phrasing", () => {
    const text = "Dispatching now to crew-fixer for the bug fix.";
    const result = parseDispatch(text, "fix the login bug");
    assert.ok(result !== null, "expected a dispatch result");
    assert.equal(result.agent, "crew-fixer");
  });

  test("uses userMessage as task text in NL fallback", () => {
    const text = "I am dispatching to crew-coder.";
    const result = parseDispatch(text, "build the checkout page");
    assert.ok(result !== null, "expected a dispatch result");
    assert.ok(result.task.includes("checkout"), `expected task to contain user message, got: ${result.task}`);
  });

  test("does not match past-tense 'dispatched' (re-dispatch prevention)", () => {
    const text = "I dispatched to crew-coder earlier and it worked.";
    const result = parseDispatch(text, "");
    assert.equal(result, null, "past tense should not match");
  });

  test("structured @@DISPATCH takes priority over NL fallback", () => {
    const text = `I'll dispatch to crew-qa.\n@@DISPATCH {"agent":"crew-coder","task":"the real task"}`;
    const result = parseDispatch(text, "user message");
    assert.equal(result.agent, "crew-coder", "structured dispatch should win");
  });
});

describe("parsePipeline — fixer re-QA insertion", () => {
  test("inserts re-QA wave after fixer when QA precedes fixer", () => {
    const text = `@@PIPELINE [
      {"wave":1,"agent":"crew-coder","task":"build"},
      {"wave":2,"agent":"crew-qa","task":"audit"},
      {"wave":3,"agent":"crew-fixer","task":"fix issues"}
    ]`;
    const result = parsePipeline(text);
    assert.ok(result !== null, "pipeline should parse");
    const qaSteps = result.steps.filter(s => s.agent === "crew-qa");
    assert.ok(qaSteps.length >= 2, `expected re-QA step to be inserted, got ${qaSteps.length} QA steps`);
  });

  test("does not insert re-QA if QA already follows fixer", () => {
    const text = `@@PIPELINE [
      {"wave":1,"agent":"crew-coder","task":"build"},
      {"wave":2,"agent":"crew-fixer","task":"fix"},
      {"wave":3,"agent":"crew-qa","task":"re-audit"}
    ]`;
    const result = parsePipeline(text);
    assert.ok(result !== null);
    const qaSteps = result.steps.filter(s => s.agent === "crew-qa");
    assert.equal(qaSteps.length, 1, "should not double-insert QA when it already follows fixer");
  });

  test("does not auto-append crew-pm when only non-coding agents present", () => {
    const text = `@@PIPELINE [
      {"wave":1,"agent":"crew-pm","task":"plan the roadmap"},
      {"wave":2,"agent":"crew-copywriter","task":"write the docs"}
    ]`;
    const result = parsePipeline(text);
    assert.ok(result !== null);
    const pmSteps = result.steps.filter(s => s.agent === "crew-pm");
    assert.equal(pmSteps.length, 1, "crew-pm should not be auto-appended when already present");
  });

  test("falls back to JSON array without @@PIPELINE marker", () => {
    const text = `Here is the plan:
[{"wave":1,"agent":"crew-coder","task":"build it"},{"wave":2,"agent":"crew-qa","task":"test it"}]`;
    const result = parsePipeline(text);
    assert.ok(result !== null, "should parse pipeline from bare JSON array");
    assert.ok(result.steps.some(s => s.agent === "crew-coder"), "should contain crew-coder");
  });
});

describe("stripThink", () => {
  test("removes <think> blocks", () => {
    const text = `<think>internal reasoning here</think>Visible reply.`;
    assert.equal(stripThink(text), "Visible reply.");
  });

  test("handles multiple think blocks", () => {
    const text = `<think>one</think>Hello<think>two</think> world`;
    assert.equal(stripThink(text), "Hello world");
  });

  test("handles null/undefined gracefully", () => {
    assert.equal(stripThink(null), null);
    assert.equal(stripThink(undefined), undefined);
  });

  test("returns unchanged text when no think blocks", () => {
    assert.equal(stripThink("plain text"), "plain text");
  });
});
