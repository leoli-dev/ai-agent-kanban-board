import { z } from 'zod';

export const QuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  context: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export const QuestionsFileSchema = z.object({
  questions: z.array(QuestionSchema).min(1),
});

export const AnswerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1),
});

export const AnswersFileSchema = z.object({
  answers: z.array(AnswerSchema).min(1),
});

export type Question = z.infer<typeof QuestionSchema>;
export type QuestionsFile = z.infer<typeof QuestionsFileSchema>;
export type Answer = z.infer<typeof AnswerSchema>;
export type AnswersFile = z.infer<typeof AnswersFileSchema>;

export const QA_JSON_CONTRACT = `{
  "questions": [
    {
      "id": "q1",
      "text": "the question to ask the user",
      "context": "why you are asking (optional)",
      "options": ["suggested answer", "..."]
    }
  ]
}`;
