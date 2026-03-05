import { Link } from 'react-router-dom';

interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  age: string;
}

const statusColor: Record<string, string> = {
  Running: 'text-green-400',
  Pending: 'text-yellow-400',
  Succeeded: 'text-blue-400',
  Failed: 'text-red-400',
  Unknown: 'text-gray-400',
};

export default function PodTable({ pods, namespace }: { pods: Pod[]; namespace: string }) {
  if (pods.length === 0) {
    return <p className="text-gray-500 py-8 text-center">No pods found</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-800 text-gray-400 text-left">
          <th className="py-2 px-3">#</th>
          <th className="py-2 px-3">Pod</th>
          <th className="py-2 px-3">Status</th>
          <th className="py-2 px-3">Containers</th>
          <th className="py-2 px-3">Age</th>
          <th className="py-2 px-3"></th>
        </tr>
      </thead>
      <tbody>
        {pods.map((pod, i) => (
          <tr key={pod.name} className="border-b border-gray-900 hover:bg-gray-900/50">
            <td className="py-2 px-3 text-gray-500">{i + 1}</td>
            <td className="py-2 px-3 font-mono">{pod.name}</td>
            <td className={`py-2 px-3 ${statusColor[pod.status] ?? 'text-gray-400'}`}>
              {pod.status}
            </td>
            <td className="py-2 px-3 text-gray-400">{pod.containers.join(', ')}</td>
            <td className="py-2 px-3 text-gray-400">{pod.age}</td>
            <td className="py-2 px-3">
              <Link
                to={`/logs/${namespace}/${pod.name}`}
                className="text-cyan-400 hover:text-cyan-300 text-xs"
              >
                View Logs
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
