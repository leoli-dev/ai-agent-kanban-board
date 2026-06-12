import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import type { PlannerMessage, Project, Question } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';
import { projectStatusStyle } from '../lib/format';
import { IconArrowLeft } from '../components/icons';

interface PlannerState {
  session: { id: string; status: string; qaRound: number } | null;
  messages: PlannerMessage[];
}

export default function PlannerChat() {
  const t = useT();
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
          <h1 className="text-xl font-semibold tracking-tight">{t('planner.title')}</h1>
          {project && (
            <Link
              to={`/projects/${projectId}`}
              className="mt-0.5 flex items-center gap-1 text-xs text-accent-300 hover:underline"
            >
              <IconArrowLeft width={12} height={12} /> {project.name}
            </Link>
          )}
        </div>
        {project && (
          <span
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${projectStatusStyle[project.status]}`}
          >
            {t(`status.${project.status}`)}
          </span>
        )}
      </div>

      {project?.status === 'planning' && (
        <div className="flex items-center gap-2.5 rounded-xl border border-accent-500/30 bg-accent-500/10 p-3 text-sm text-accent-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent-400" />
          {t('planner.working')}
        </div>
      )}

      <div className="space-y-3">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {messages.length === 0 && <p className="text-sm text-ink-500">{t('planner.noActivity')}</p>}
      </div>

      {pendingQuestions.length > 0 && (
        <div className="rounded-xl border border-accent-500/40 bg-accent-500/5 p-4">
          <h2 className="mb-3 text-sm font-semibold text-accent-300">{t('planner.needsInput')}</h2>
          <div className="space-y-4">
            {pendingQuestions.map((q) => (
              <div key={q.id}>
                <p className="text-sm font-medium text-ink-100">{q.text}</p>
                {q.context && <p className="mt-0.5 text-xs text-ink-400">{q.context}</p>}
                {q.options && q.options.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {q.options.map((opt) => (
                      <button
                        key={opt}
                        onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                        className={`rounded-lg border px-3 py-1 text-xs transition-colors duration-150 ${
                          answers[q.id] === opt
                            ? 'border-accent-400 bg-accent-400/20 text-accent-200'
                            : 'border-ink-700 text-ink-300 hover:border-ink-500'
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
                  placeholder={t('planner.answerPlaceholder')}
                  className="input-base mt-2"
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
            className="btn btn-primary mt-4 w-full py-2.5 text-sm font-semibold"
          >
            {sendAnswers.isPending ? t('planner.sending') : t('planner.sendAnswers')}
          </button>
        </div>
      )}

      {project?.status === 'awaiting_approval' && (
        <Link
          to={`/projects/${projectId}`}
          className="btn btn-primary py-3 text-center text-sm font-semibold"
        >
          {t('planner.planReady')} →
        </Link>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: PlannerMessage }) {
  const t = useT();
  const content = message.content as Record<string, unknown>;
  if (message.role === 'question') {
    const questions = (content.questions as Question[]) ?? [];
    return (
      <div className="rounded-xl border border-accent-500/25 bg-ink-900 p-3">
        <p className="mb-1 text-xs font-semibold text-accent-300">{t('planner.asked')}</p>
        <ul className="list-inside list-disc space-y-1 text-sm text-ink-200">
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
        isUser ? 'ml-8 bg-ink-850 text-ink-200' : 'mr-8 border border-ink-800 bg-ink-900 text-ink-300'
      }`}
    >
      <p className="mb-1 text-xs font-semibold text-ink-500">
        {isUser ? t('planner.you') : t('planner.agent')}
      </p>
      <div className="prose prose-sm prose-invert max-w-none">
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    </div>
  );
}
