import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Multi-turn stress test: exercises scratchpad writes, reads, deletes, and cross-session isolation across 5 consecutive complex turns with escalating difficulty.",
  timeoutMs: 300000,
  async test(t) {
    // Turn 1: Scratchpad write + researcher delegation
    await t.send(
      `Step 1: Use the scratchpad tool to write the following JSON under key "project.config": {"target":"UPSC","budget":500000,"currency":"INR","timeline":"12 months"}

Step 2: Delegate to your researcher subagent and ask it to search the web for "UPSC CSE 2025 exam pattern changes" and store the findings in scratchpad under key "research.upsc_changes".

Step 3: Confirm both scratchpad writes succeeded by reading both keys back and reporting the values.`,
    );
    t.succeeded();

    // Turn 2: Analyst delegation + scratchpad read chain
    await t.send(
      `I see you stored the project config. Now do the following:

1. Read "project.config" from the scratchpad.
2. Using the budget value from that config (500000 INR), delegate to your analyst subagent and ask it to: calculate the monthly marketing spend if 40% of the total budget is allocated to marketing over 12 months, and calculate the daily budget. Also calculate what percentage of the budget would be consumed by a ₹25,000/month office lease for 12 months.
3. Store the analyst's calculations in scratchpad under key "analysis.budget_breakdown".
4. Report the monthly marketing spend and the lease consumption percentage.`,
    );
    t.succeeded();

    // Turn 3: Planner delegation with scratchpad dependency
    await t.send(
      `Now delegate to your planner subagent with this task:

Read the project config from "project.config" and the budget breakdown from "analysis.budget_breakdown". Create a 6-month content creation plan for a competitive exam prep platform targeting UPSC aspirants. The plan must:
- Allocate budget across months based on the monthly marketing spend from the budget breakdown
- Include at least 8 content deliverables (mock tests, video lessons, study notes, etc.)
- Specify which weeks each deliverable should be completed
- Note dependencies between deliverables (e.g., study notes must come before mock tests)

Store the plan in scratchpad under "planning.content_roadmap" and also read it back to confirm it was stored correctly.`,
    );
    t.succeeded();

    // Turn 4: Writer delegation with multi-key scratchpad read
    await t.send(
      `Delegate to your writer subagent with this instruction:

Read ALL of the following scratchpad keys:
- "project.config" (project parameters)
- "research.upsc_changes" (research findings)
- "analysis.budget_breakdown" (financial analysis)
- "planning.content_roadmap" (content plan)

Using all of this context, write a 300-word internal project brief that:
1. Opens with the project goal and target audience
2. Summarizes the key UPSC exam changes found in research
3. Shows the budget allocation in a simple breakdown
4. Lists the first 3 deliverables from the content roadmap with their deadlines

Store the final brief in scratchpad under "writing.project_brief_v1".`,
    );
    t.succeeded();

    // Turn 5: Verification + scratchpad cleanup
    await t.send(
      `Final verification step:

1. List ALL keys currently in the scratchpad (use the list operation).
2. Read each key and confirm the content is non-empty and substantive (not just a confirmation message).
3. Report: total number of scratchpad keys, the approximate character count of each value, and whether any key contains placeholder or stub text.
4. Delete the key "project.config" from the scratchpad.
5. List keys again to confirm deletion.

This verifies the full scratchpad lifecycle: write → read → cross-reference → delete.`,
    );
    t.succeeded();
  },
});
