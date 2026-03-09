import { useState } from 'react';
import { Link } from 'react-router-dom';

export interface ContainerGroup {
  container: string;
  podCount: number;
  statuses: string[];
  pods: { name: string; status: string; age: string }[];
}

const statusColor: Record<string, string> = {
  Running: 'text-green-400',
  Pending: 'text-yellow-400',
  Succeeded: 'text-blue-400',
  Failed: 'text-red-400',
  Unknown: 'text-gray-400',
};

export default function ContainerTable({ groups, namespace }: { groups: ContainerGroup[]; namespace: string }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (groups.length === 0) {
    return <p className="text-gray-500 py-8 text-center">No containers found</p>;
  }

  const toggle = (container: string) =>
    setExpanded((prev) => ({ ...prev, [container]: !prev[container] }));

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-800 text-gray-400 text-left">
          <th className="py-2 px-3 w-8"></th>
          <th className="py-2 px-3">#</th>
          <th className="py-2 px-3">Container</th>
          <th className="py-2 px-3">Pods</th>
          <th className="py-2 px-3">Status</th>
          <th className="py-2 px-3"></th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g, i) => (
          <>
            <tr key={g.container} className="border-b border-gray-900 hover:bg-gray-900/50">
              <td className="py-2 px-3">
                <button
                  onClick={() => toggle(g.container)}
                  className="text-gray-500 hover:text-white transition-transform"
                >
                  <span className={`inline-block transition-transform ${expanded[g.container] ? 'rotate-90' : ''}`}>
                    &#9654;
                  </span>
                </button>
              </td>
              <td className="py-2 px-3 text-gray-500">{i + 1}</td>
              <td className="py-2 px-3 font-mono">{g.container}</td>
              <td className="py-2 px-3 text-gray-400">{g.podCount}</td>
              <td className="py-2 px-3">
                <span className="flex flex-wrap gap-1">
                  {g.statuses.map((s) => (
                    <span key={s} className={statusColor[s] ?? 'text-gray-400'}>{s}</span>
                  ))}
                </span>
              </td>
              <td className="py-2 px-3">
                <Link
                  to={`/logs/${namespace}/container/${encodeURIComponent(g.container)}`}
                  className="text-cyan-400 hover:text-cyan-300 text-xs"
                >
                  View Logs
                </Link>
              </td>
            </tr>
            {expanded[g.container] &&
              g.pods.map((pod) => (
                <tr key={pod.name} className="bg-gray-900/40">
                  <td className="py-1.5 px-3"></td>
                  <td className="py-1.5 px-3"></td>
                  <td className="py-1.5 px-3 font-mono text-gray-400 pl-6">{pod.name}</td>
                  <td className="py-1.5 px-3"></td>
                  <td className={`py-1.5 px-3 ${statusColor[pod.status] ?? 'text-gray-400'}`}>
                    {pod.status}
                  </td>
                  <td className="py-1.5 px-3 text-gray-500 text-xs">{pod.age}</td>
                </tr>
              ))}
          </>
        ))}
      </tbody>
    </table>
  );
}
