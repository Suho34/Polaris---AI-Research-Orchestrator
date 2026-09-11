import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "Orchestrator-only stress: forces the model to handle a long, ambiguous, multi-part prompt that tests clarification, planning, error recovery, and synthesis without delegating to subagents.",
  timeoutMs: 180000,
  async test(t) {
    await t.send(
      `I have a dataset of 10,000 student performance records from a competitive exam mock test series. Each record has: student_id, subject (Math/English/GeneralKnowledge/CurrentAffairs), score (0-100), time_taken_seconds (60-1800), question_type (MCQ/Descriptive/SentenceCompletion), difficulty (Easy/Medium/Hard), date_attempted, and is_correct (boolean).

I need you to do ALL of the following in one comprehensive response. This is not a delegation task — I want YOU to work through each part:

PART A — Statistical Analysis:
1. Calculate the overall accuracy rate (percentage of is_correct=true across all records).
2. Identify which subject has the highest average score and which has the lowest.
3. Determine the correlation between time_taken_seconds and is_correct — do students who take longer tend to get more questions right?
4. Find the top 10% of students by overall performance and describe their characteristics (which subjects they excel in, average time per question, difficulty distribution).

PART B — Anomaly Detection:
5. Identify students who scored above 90% on Hard questions but below 50% on Easy questions — these are suspicious patterns.
6. Find any subject where the average score dropped by more than 15% month-over-month — this indicates a curriculum gap.
7. Detect students who consistently finish in under 30 seconds per question with accuracy below 40% — possible guessing behavior.

PART C — Predictive Insights:
8. Based on the data, predict which students are at risk of failing the actual exam (define your threshold and justify it).
9. Recommend 3 targeted intervention strategies for the weakest subject, backed by the data patterns you found.
10. Propose a adaptive difficulty algorithm: how should the platform adjust question difficulty based on a student's recent 20-question performance window?

PART D — Data Quality:
11. List any data quality issues you would look for in this dataset and how you would handle them.
12. Suggest 3 additional data fields that would improve the analysis and explain why each would be valuable.

Format your response with clear headers for each part. Use tables where appropriate. Be specific with numbers — do not give vague qualitative answers.`,
    );

    t.succeeded();

    // Verify the agent addressed all 4 parts
    t.check(t.reply, includes("PART A"));
    t.check(t.reply, includes("PART B"));
    t.check(t.reply, includes("PART C"));
    t.check(t.reply, includes("PART D"));
  },
});
