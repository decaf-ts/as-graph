/**
 * @jest-environment jsdom
 *
 * @module as-graph/tests/storybook/stories.test
 * @summary Runs every storybook story's render + play in jsdom.
 * @description Hermetic story runner: imports the as-graph story modules, mounts
 * each story's `render` output into a canvas and runs its `play` interaction
 * assertions. This exercises the same stories that `storybook build` bundles for the
 * browser, so both the interaction tests and the browser bundle are verified
 * without a heavyweight Playwright test-runner.
 */
import type { StoryObj } from "@storybook/html-vite";
import * as agentStories from "./nodes/agent.stories";
import * as flowControlStories from "./nodes/flow-control.stories";
import * as loopStories from "./nodes/loops.stories";
import * as triggerStories from "./nodes/triggers.stories";
import * as utilityStories from "./nodes/utility.stories";
import * as foreachStories from "./workflows/foreach.stories";
import * as linearStories from "./workflows/linear.stories";
import * as switchBranchStories from "./workflows/switch-branch.stories";

/** Every story module, keyed by its storybook title group. */
const STORY_MODULES: Record<string, Record<string, unknown>> = {
  "Nodes/Triggers": triggerStories,
  "Nodes/Flow Control": flowControlStories,
  "Nodes/Utility": utilityStories,
  "Nodes/Loops": loopStories,
  "Nodes/Agents": agentStories,
  "Workflows/Linear": linearStories,
  "Workflows/Foreach": foreachStories,
  "Workflows/Switch Branch": switchBranchStories,
};

interface StoryEntry {
  file: string;
  name: string;
  story: StoryObj;
}

const STORIES: StoryEntry[] = Object.entries(STORY_MODULES).flatMap(
  ([file, module]) =>
    Object.entries(module)
      .filter(([name]) => name !== "default")
      .map(([name, story]) => ({ file, name, story: story as StoryObj }))
);

describe("graph storybook stories", () => {
  it("covers every built-in node kind in isolation", () => {
    const nodeStories = STORIES.filter((entry) =>
      entry.file.startsWith("Nodes/")
    );
    expect(nodeStories).toHaveLength(23);
  });

  it("covers the multi-node workflows before and after a run", () => {
    const workflowStories = STORIES.filter((entry) =>
      entry.file.startsWith("Workflows/")
    );
    expect(workflowStories).toHaveLength(6);
  });

  for (const { file, name, story } of STORIES) {
    it(`${file} :: ${name}`, async () => {
      expect(typeof story.render).toBe("function");
      expect(typeof story.play).toBe("function");

      const canvas = document.createElement("div");
      document.body.appendChild(canvas);
      try {
        const rendered = await story.render?.({}, {} as never);
        if (typeof rendered === "string") {
          canvas.innerHTML = rendered;
        } else if (rendered) {
          canvas.appendChild(rendered as Node);
        }
        await story.play?.({ canvasElement: canvas } as never);
      } finally {
        canvas.remove();
      }
    });
  }
});
