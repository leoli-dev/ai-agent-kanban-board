import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import type { PlannerMessage, Project, Question } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { projectStatusLabel, projectStatusStyle } from '../lib/format';

interface PlannerState {
  session: { id: string; status: string; qaRound: number } | null;
  messages: PlannerMessage[];
}

export default function PlannerChat() {
  const { projectId = '' } = useParams();
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/api/projects/${projectId}`),
  });
  const { data: planner } = useQuery({
    queryKey: ['planner', projectId],
    queryFn: () => api.get<PlannerState>(`/api/projects/${projectId}/planner`),
    refetchInterval: 5000,
  });

  useWsTopics(['global', `board:${projectId}`], (msg) => {
    if (
      msg.type === 'question.pending' ||
      msg.type === 'plan.ready' ||
      msg.type === 'project.updated' ||
      msg.type === 'run.updated'
    ) {
      queryClient.invalidateQueries({ queryKey: ['planner', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    }
  });

  const sendAnswers = useMutation({
    mutationFn: (payload: { questionId: string; answer: string }[]) =>
      api.post(`/api/projects/${projectId}/plan/answers`, { answers: payload }),
    onSuccess: () => {
      setAnswers({});
      queryClient.invalidateQueries({ queryKey: ['planner', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const messages = planner?.messages ?? [];
  const lastQuestionMsg = [...messages].reverse().find((m) => m.role === 'question');
  const pendingQuestions =
    project?.status === 'awaiting_answers' && lastQuestionMsg
      ? ((lastQuestionMsg.content as { questions: Question[] }).questions ?? [])
      : [];
  const allAnswered = pendingQuestions.every((q) => (answers[q.id] ?? '').trim());

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Planner</h1>
          {project && (
            <Link to={`/projects/${projectId}`} className="text-xs text-sky-400 hover:underline">
              ← {project.name}
            </Link>
          )}
        </div>
        {project && (
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${projectStatusStyle[project.status]}`}>
            {projectStatusLabel[project.status]}
          </span>
        )}
      </div>

      {project?.status === 'planning' && (
        <div className="flex items-center gap-2 rounded-xl border border-indigo-800 bg-indigo-950/40 p-3 text-sm text-indigo-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
          The planner agent is working… this can take a few minutes.
        </div>
      )}

      <div className="space-y-3">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {messages.length === 0 && (
          <p className="text-sm text-slate-500">No planner activity yet.</p>
        )}
      </div>

      {pendingQuestions.length > 0 && (
        <div className="rounded-xl border border-amber-700/60 bg-amber-950/30 p-4">
          <h2 className="mb-3 text-sm font-semibold text-amber-300">
            The planner needs your input
          </h2>
          <div className="space-y-4">
            {pendingQuestions.map((q) => (
              <div key={q.id}>
                <p className="text-sm font-medium text-slate-200">{q.text}</p>
                {q.context && <p className="mt-0.5 text-xs text-slate-400">{q.context}</p>}
                {q.options && q.options.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {q.options.map((opt) => (
                      <button
                        key={opt}
                        onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                        className={`rounded-full border px-3 py-1 text-xs ${
                          answers[q.id] === opt
                            ? 'border-sky-500 bg-sky-600/30 text-sky-200'
                            : 'border-slate-600 text-slate-300 hover:border-slate-400'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  value={answers[q.id] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  rows={2}
                  placeholder="Your answer…"
                  className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm outline-none focus:border-sky-500"
                />
              </div>
            ))}
          </div>
          <button
            onClick={() =>
              sendAnswers.mutate(
                pendingQuestions.map((q) => ({ questionId: q.id, answer: answers[q.id]!.trim() })),
              )
            }
            disabled={!allAnswered || sendAnswers.isPending}
            className="mt-4 w-full rounded-lg bg-amber-600 py-2.5 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-40"
          >
            {sendAnswers.isPending ? 'Sending…' : 'Send answers to planner'}
          </button>
        </div>
      )}

      {project?.status === 'awaiting_approval' && (
        <Link
          to={`/projects/${projectId}`}
          className="rounded-xl bg-violet-600 py-3 text-center text-sm font-semibold text-white hover:bg-violet-500"
        >
          Plan is ready — review &amp; approve →
        </Link>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: PlannerMessage }) {
  const content = message.content as Record<string, unknown>;
  if (message.role === 'question') {
    const questions = (content.questions as Question[]) ?? [];
    return (
      <div className="rounded-xl border border-amber-800/50 bg-slate-900 p-3">
        <p className="mb-1 text-xs font-semibold text-amber-400">Planner asked</p>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-200">
          {questions.map((q) => (
            <li key={q.id}>{q.text}</li>
          ))}
        </ul>
      </div>
    );
  }
  const text = typeof content.text === 'string' ? content.text : JSON.stringify(content);
  const isUser = message.role === 'user' || message.role === 'answer';
  return (
    <div
      className={`rounded-xl p-3 text-sm ${
        isUser ? 'ml-8 bg-sky-950/50 text-slate-200' : 'mr-8 border border-slate-800 bg-slate-900 text-slate-300'
      }`}
    >
      <p className="mb-1 text-xs font-semibold text-slate-500">
        {isUser ? 'You' : 'Planner'}
      </p>
      <div className="prose prose-sm prose-invert max-w-none">
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    </div>
  );
}
