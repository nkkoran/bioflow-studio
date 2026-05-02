export function RawTextView({ text }: { text: string }) {
  const lines = text.length > 0 ? text.split('\n') : ['']
  return (
    <div className="grid h-full min-w-full grid-cols-[3.5rem_minmax(0,1fr)] overflow-auto bg-bg-primary text-xs font-mono">
      <div className="select-none bg-bg-secondary py-2 text-right text-text-muted shadow-sm">
        {lines.map((_, idx) => (
          <div key={idx} className="px-2 leading-5">{idx + 1}</div>
        ))}
      </div>
      <pre
        tabIndex={0}
        className="m-0 min-w-max select-text whitespace-pre px-3 py-2 leading-5 text-text-primary outline-none focus:bg-bg-secondary/30"
      >
        {text || ' '}
      </pre>
    </div>
  )
}
