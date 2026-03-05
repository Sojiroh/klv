import { Routes, Route, Link, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Logs from './pages/Logs';
import Stream from './pages/Stream';
import Search from './pages/Search';

const navItems = [
  { path: '/', label: 'Dashboard' },
  { path: '/stream', label: 'Stream' },
  { path: '/search', label: 'Search' },
];

export default function App() {
  const location = useLocation();

  return (
    <div className="min-h-screen">
      <nav className="border-b border-gray-800 px-6 py-3 flex items-center gap-6">
        <span className="text-lg font-bold text-cyan-400">KLV</span>
        {navItems.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={`text-sm ${
              location.pathname === item.path
                ? 'text-white font-medium'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/logs/:namespace/:pod" element={<Logs />} />
          <Route path="/stream" element={<Stream />} />
          <Route path="/search" element={<Search />} />
        </Routes>
      </main>
    </div>
  );
}
