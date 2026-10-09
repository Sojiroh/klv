export default function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="klv-card border-red-500/30 bg-red-500/5 px-4 py-3 mb-4 text-sm text-red-400 font-mono break-all">
      {message}
    </div>
  );
}
