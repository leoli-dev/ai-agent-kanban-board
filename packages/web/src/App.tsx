import { NavLink, Route, Routes } from 'react-router-dom';
import Board from './pages/Board';
import NewProject from './pages/NewProject';
import ProjectDetail from './pages/ProjectDetail';
import PlannerChat from './pages/PlannerChat';
import TaskDetail from './pages/TaskDetail';
import Projects from './pages/Projects';
import Settings from './pages/Settings';
import { NotificationBell } from './components/NotificationBell';

const tabs = [
  { to: '/', label: 'Board', icon: '▦' },
  { to: '/projects', label: 'Projects', icon: '◫' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <NavLink to="/" className="text-sm font-bold tracking-wide text-slate-100">
          ⚡ Agent Kanban
        </NavLink>
        <div className="flex items-center gap-3">
          <nav className="hidden items-center gap-1 sm:flex">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.to === '/'}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm ${
                    isActive
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                  }`
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
          <NotificationBell />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto pb-16 sm:pb-0">
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/new" element={<NewProject />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/projects/:projectId/board" element={<Board />} />
          <Route path="/projects/:projectId/planner" element={<PlannerChat />} />
          <Route path="/tasks/:taskId" element={<TaskDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-slate-800 bg-slate-900/95 backdrop-blur sm:hidden">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === '/'}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
                isActive ? 'text-sky-400' : 'text-slate-400'
              }`
            }
          >
            <span className="text-base leading-none">{t.icon}</span>
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
