export function RawTextView({ text }: { text: string }) {
  const lines = text.length > 0 ? text.split('\n') : ['']
  return (
    <div className="h-full overflow-auto bg-bg-primary text-xs font-mono">
      <table className="min-w-full border-collapse">
        <tbody>
          {lines.map((line, idx) => (
            <tr key={idx} className="align-top">
              <td className="sticky left-0 select-none border-r border-border bg-bg-secondary px-2 py-0.5 text-right text-text-muted">
                {idx + 1}
              </td>
              <td className="whitespace-pre px-3 py-0.5 text-text-primary">
                {line || ' '}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
