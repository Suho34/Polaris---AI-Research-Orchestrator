import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "Stress test: forces orchestrator to delegate to all 4 subagents (researcher, analyst, planner, writer) with scratchpad cross-handoffs, multi-step reasoning, and data synthesis.",
  timeoutMs: 300000,
  async test(t) {
    await t.send(
      `You are Polaris. This is a comprehensive multi-domain research and planning task. You MUST use all four of your specialists (researcher, analyst, planner, writer) and the scratchpad for cross-agent handoffs. Do not try to do everything yourself.

## TASK

I am launching a new SaaS product: an AI-powered competitive exam preparation platform targeting Indian government exam aspirants (UPSC, SSC, banking, state PSCs). I need a complete go-to-market strategy document.

### Phase 1 — Research (use researcher)
Delegate to your researcher subagent to investigate ALL of the following. Store results in the scratchpad under 'research.market' and 'research.competitors':

1. Current market size of India's edtech test-prep sector (2024-2026 figures). Include both overall market and the competitive exam niche specifically.
2. The top 5 competitors in the competitive exam prep space (Testbook, PracticeMock, Adda247, Gradeup/Byju's Exam Prep, Unacademy). For EACH competitor, find: their pricing model, monthly active users or subscriber count if available, key features, and any known weaknesses or negative user reviews.
3. Recent regulatory changes in India affecting edtech companies (any new guidelines from the Ministry of Education, UGC, or state governments in 2025-2026).
4. AI adoption trends in Indian education — how many edtech platforms are currently using AI/ML features, and what specific AI features are most popular (adaptive testing, personalized study plans, answer explanation generators, etc.).

### Phase 2 — Analysis (use analyst)
After researcher returns, delegate to your analyst subagent. Store results in scratchpad under 'analysis.financials' and 'analysis.pricing':

1. Based on the competitor pricing data from Phase 1, calculate: average monthly subscription price, price range (min/max), and standard deviation. Present this as a pricing benchmark table.
2. Build a 3-year revenue projection model with these assumptions:
   - Year 1: 5,000 paid subscribers at ₹499/month, 15% monthly churn, 20% MoM growth in new signups starting from 500/month
   - Year 2: Price increase to ₹699/month, churn drops to 10%, growth rate becomes 10% MoM
   - Year 3: Price at ₹999/month, churn at 7%, growth rate 5% MoM
   Calculate: total revenue per year, cumulative revenue, peak subscriber count, and break-even point assuming ₹15 lakh/month fixed costs.
3. Calculate the Customer Acquisition Cost (CAC) if the marketing budget is 30% of Year 1 revenue and conversion rate from free trial to paid is 8%.

### Phase 3 — Planning (use planner)
Delegate to your planner subagent. Store the plan in scratchpad under 'planning.gtm':

Create a detailed 12-month go-to-market roadmap with:
- Pre-launch phase (months 1-3): product beta, content creation, influencer partnerships
- Launch phase (months 4-6): pricing strategy, marketing channels, referral program
- Growth phase (months 7-12): feature expansion, regional language support, B2B sales to coaching institutes

Include dependencies between tasks, critical path items, and at least 3 specific milestones with dates.

### Phase 4 — Writing (use writer)
Finally, delegate to your writer subagent. Have it read ALL scratchpad keys (research.market, research.competitors, analysis.financials, analysis.pricing, planning.gtm) and synthesize a polished executive summary document. The document should:

1. Start with a 1-paragraph executive summary
2. Include a Market Overview section with the research findings
3. Include a Competitive Landscape section with a comparison table
4. Include a Financial Projections section with the revenue model
5. Include a Go-to-Market Roadmap section with the timeline
6. End with Key Risks and Mitigations (at least 4 risks)

### Validation
After all phases are complete, verify the final document covers all sections and contains no placeholder text. Report the total word count of the final document.`,
    );

    // The agent must complete successfully
    t.succeeded();

    // Verify the response contains substantive content from each phase
    t.check(t.reply, includes("executive summary"));
    t.check(t.reply, includes("revenue"));
  },
});
