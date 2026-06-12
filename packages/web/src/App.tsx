import { NavLink, Route, Routes } from 'react-router-dom';
import Activity from './pages/Activity';
import Board from './pages/Board';
import NewProject from './pages/NewProject';
import ProjectDetail from './pages/ProjectDetail';
import PlannerChat from './pages/PlannerChat';
import TaskDetail from './pages/TaskDetail';
import Projects from './pages/Projects';
import Settings from './pages/Settings';
import { NotificationBell } from './components/NotificationBell';
import { IconBoard, IconBolt, IconFolder, IconGear, IconSpark } from './components/icons';
import { useT } from './lib/i18n';
import { useWsStatus } from './lib/ws';

export default function App() {
  const t = useT();
  const wsStatus = useWsStatus();

  const tabs = [
    { to: '/', label: t('nav.board'), icon: IconBoard },
    { to: '/projects', label: t('nav.projects'), icon: IconFolder },
    { to: '/activity', label: t('nav.activity'), icon: IconSpark },
    { to: '/settings', label: t('nav.settings'), icon: IconGear },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="relative z-40 flex items-center justify-between border-b border-ink-800 bg-ink-900/80 px-4 py-2 backdrop-blur">
        <NavLink to="/" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-400 text-ink-950">
            <IconBolt width={15} height={15} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink-100">
            {t('app.name')}
          </span>
        </NavLink>

        <div className="flex items-center gap-2">
          <nav className="hidden items-center gap-0.5 sm:flex">
            {tabs.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors duration-150 ${
                    isActive
                      ? 'bg-ink-800 font-medium text-accent-300'
                      : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200'
                  }`
                }
              >
                <Icon width={15} height={15} />
                {label}
              </NavLink>
            ))}
          </nav>

          <span
            title={wsStatus}
            className={`mx-1 inline-block h-2 w-2 rounded-full transition-colors ${
              wsStatus === 'online'
                ? 'bg-teal-400'
                : wsStatus === 'connecting'
                  ? 'animate-pulse bg-accent-400'
                  : 'bg-red-500'
            }`}
          />
          <NotificationBell />
        </div>
      </header>

      {wsStatus === 'offline' && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-1.5 text-center text-xs text-red-300">
          Connection lost — retrying… changes won't appear live until it's back.
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-auto pb-16 sm:pb-0">
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/new" element={<NewProject />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/projects/:projectId/board" element={<Board />} />
          <Route path="/projects/:projectId/planner" element={<PlannerChat />} />
          <Route path="/tasks/:taskId" element={<TaskDetail />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-ink-800 bg-ink-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        {tabs.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-1 py-2 text-[11px] transition-colors ${
                isActive ? 'text-accent-300' : 'text-ink-400'
              }`
            }
          >
            <Icon width={18} height={18} />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
