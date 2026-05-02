import { useEffect, useRef, useState } from 'react'

export function useSuccessAnimation(status?: string) {
  const previousStatus = useRef(status)
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (previousStatus.current !== status && status === 'done') {
      setActive(true)
      const timer = window.setTimeout(() => setActive(false), 700)
      previousStatus.current = status
      return () => window.clearTimeout(timer)
    }

    previousStatus.current = status
    return undefined
  }, [status])

  return active
}
