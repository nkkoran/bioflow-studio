export function middleEllipsis(value: string, max = 42): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export function MiddleEllipsis({
  value,
  max = 42,
  className,
}: {
  value: string
  max?: number
  className?: string
}) {
  return (
    <span className={className} title={value}>
      {middleEllipsis(value, max)}
    </span>
  )
}
