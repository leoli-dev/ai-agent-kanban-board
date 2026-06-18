import { z } from 'zod';

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  roleHint: z.string().optional(),
  complexity: z.enum(['low', 'medium', 'high']).optional(),
});

export const PlanDocSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanDoc = z.infer<typeof PlanDocSchema>;

/** Output of splitting ONE existing task into smaller subtasks (>= 2). Subtask
 * `dependsOn` references sibling subtask ids only; external wiring (the original
 * task's deps and dependents) is rehung by the server. */
export const SubtaskPlanSchema = z.object({
  subtasks: z.array(PlanStepSchema).min(2),
});

export type SubtaskPlan = z.infer<typeof SubtaskPlanSchema>;

/** JSON-schema-ish description embedded into the planner prompt. */
export const PLAN_JSON_CONTRACT = `{
  "title": "short project title",
  "summary": "one-paragraph summary of the overall plan",
  "steps": [
    {
      "id": "step-1",
      "title": "imperative step title",
      "description": "detailed instructions a coding sub-agent can execute independently",
      "acceptanceCriteria": ["verifiable criterion", "..."],
      "dependsOn": ["ONLY ids of steps whose output this step strictly needs — leave empty for independent steps, they run in parallel"],
      "complexity": "low | medium | high"
    }
  ]
}`;

/** JSON-schema-ish description embedded into the task-decompose prompt. */
export const SUBTASK_JSON_CONTRACT = `{
  "subtasks": [
    {
      "id": "sub-1",
      "title": "imperative subtask title",
      "description": "instructions for ONE focused unit of work a coding sub-agent can execute AND self-verify in well under 30 minutes",
      "acceptanceCriteria": ["verifiable criterion", "..."],
      "dependsOn": ["ONLY sibling subtask ids (e.g. sub-1) this subtask strictly needs — leave empty for independent subtasks"],
      "complexity": "low | medium | high"
    }
  ]
}`;
