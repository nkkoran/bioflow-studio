export function isLikelyLocalPath(path: string | undefined): boolean {
  const trimmed = path?.trim() ?? ''
  return /^(\/Users\/|\/Volumes\/|\/private\/|[A-Za-z]:[\\/])/.test(trimmed)
}
