import { Routes, Route, Link, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Logs from './pages/Logs';
import Stream from './pages/Stream';
import Search from './pages/Search';

const navItems = [
  { path: '/', label: 'Dashboard', icon: '⬡' },
  { path: '/stream', label: 'Stream', icon: '◉' },
  { path: '/search', label: 'Search', icon: '⌕' },
];

export default function App() {
  const location = useLocation();
  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  return (
    <div className="min-h-screen noise-bg">
      {/* Top nav */}
      <nav className="sticky top-0 z-30 bg-klv-base/80 backdrop-blur-xl border-b border-klv-border">
        <div className="px-6 py-3 flex items-center gap-1">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2.5 mr-8 group">
            <span className="text-xl font-display font-extrabold tracking-tight text-klv-accent
                           group-hover:text-klv-accent-hover transition-colors">
              KLV
            </span>
            <span className="text-[10px] font-mono text-klv-text-muted tracking-wider hidden sm:block">
              KUBE LOG VIEWER
            </span>
          </Link>

          {/* Nav items */}
          <div className="flex items-center gap-1">
            {navItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className={`
                  relative px-3 py-1.5 text-sm font-body font-medium rounded-lg
                  transition-all duration-200
                  ${isActive(item.path)
                    ? 'text-klv-text bg-klv-elevated'
                    : 'text-klv-text-muted hover:text-klv-text-secondary hover:bg-klv-surface'
                  }
                `}
              >
                <span className="mr-1.5 text-xs opacity-60">{item.icon}</span>
                {item.label}
                {isActive(item.path) && (
                  <span className="absolute -bottom-[13px] left-1/2 -translate-x-1/2 w-6 h-0.5 bg-klv-accent rounded-full" />
                )}
              </Link>
            ))}
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="px-6 py-6 max-w-[1440px] mx-auto animate-fade-in">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/logs/:namespace/container/:container" element={<Logs />} />
          <Route path="/logs/:namespace/:pod" element={<Logs />} />
          <Route path="/stream" element={<Stream />} />
          <Route path="/search" element={<Search />} />
        </Routes>
      </main>
    </div>
  );
}
