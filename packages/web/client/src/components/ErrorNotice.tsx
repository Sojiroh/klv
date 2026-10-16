export default function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="klv-card border-red-200 bg-red-50 px-4 py-3 mb-4 text-sm text-red-600 font-mono break-all">
      {message}
    </div>
  );
}
