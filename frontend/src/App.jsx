import React from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import Import from './pages/Import.jsx';
import Endpoints from './pages/Endpoints.jsx';
import Flows from './pages/Flows.jsx';
import Schedules from './pages/Schedules.jsx';
import JsonDiff from './pages/JsonDiff.jsx';
import { ConfirmProvider } from './components/ConfirmProvider.jsx';
import { ToastProvider } from './components/ToastProvider.jsx';

const ICONS = {
  dashboard: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  import: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 19h16" />
    </svg>
  ),
  endpoints: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h13" />
    </svg>
  ),
  flows: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="6" r="2.3" /><circle cx="19" cy="12" r="2.3" /><circle cx="5" cy="18" r="2.3" />
      <path d="M7 6h6a4 4 0 0 1 4 4v0" /><path d="M7 18h6a4 4 0 0 0 4-4v0" />
    </svg>
  ),
  schedules: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />
    </svg>
  ),
  jsonDiff: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="8" height="16" rx="1.5" /><rect x="13" y="4" width="8" height="16" rx="1.5" />
      <path d="M9.5 12h5" /><path d="M12.5 9.5l2.5 2.5-2.5 2.5" />
    </svg>
  ),
};

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/import', label: 'Import', icon: 'import' },
  { to: '/endpoints', label: 'Config', icon: 'endpoints' },
  { to: '/flows', label: 'Flows', icon: 'flows' },
  { to: '/schedules', label: 'Schedules', icon: 'schedules' },
  { to: '/json-diff', label: 'JSON Diff', icon: 'jsonDiff' },
];

export default function App() {
  return (
    <BrowserRouter>
    <ToastProvider>
    <ConfirmProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">
              <img src="/logo_privy.png" alt="Privy" />
            </span>
            <div>
              <div>QA Toolkit</div>
              <div className="brand-sub">API Testing &amp; Monitoring</div>
            </div>
          </div>

          <ul className="nav-list">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  {ICONS[item.icon]}
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>

          <div className="sidebar-footer">© 2026 Dendy Pratama</div>
        </aside>

        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/import" element={<Import />} />
            <Route path="/endpoints" element={<Endpoints />} />
            <Route path="/flows" element={<Flows />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/json-diff" element={<JsonDiff />} />
          </Routes>
        </main>
      </div>
    </ConfirmProvider>
    </ToastProvider>
    </BrowserRouter>
  );
}
