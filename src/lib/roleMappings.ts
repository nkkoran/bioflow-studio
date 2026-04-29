import type { DataRoleDef, RoleMapping } from '@/types/readiness'

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function matchAliases(column: string, aliases: string[]): { confidence: number; aliasesMatched: string[] } | null {
  const normalizedColumn = normalize(column)
  for (const alias of aliases) {
    if (!alias.trim()) continue
    const normalizedAlias = normalize(alias)
    if (column === alias) return { confidence: 1, aliasesMatched: [alias] }
    if (column.toLowerCase() === alias.toLowerCase()) return { confidence: 0.98, aliasesMatched: [alias] }
    if (normalizedColumn === normalizedAlias) return { confidence: 0.94, aliasesMatched: [alias] }
  }
  return null
}

export function suggestRoleMapping(columnNames: string[], role: DataRoleDef, existing?: RoleMapping | null): RoleMapping {
  if (existing?.confirmed && (existing.column || (existing.columns?.length ?? 0) > 0)) return existing

  const aliases = [role.id, ...(role.aliases ?? [])]
  let best: RoleMapping | null = existing ?? null

  for (const column of columnNames) {
    const match = matchAliases(column, aliases)
    if (!match) continue
    if (!best || (best.confidence ?? 0) < match.confidence) {
      best = {
        roleId: role.id,
        column,
        confidence: match.confidence,
        aliasesMatched: match.aliasesMatched,
        confirmed: existing?.confirmed ?? false,
        transform: existing?.transform ?? 'identity',
      }
    }
  }

  return best ?? {
    roleId: role.id,
    confirmed: existing?.confirmed ?? false,
    transform: existing?.transform ?? 'identity',
  }
}

export function suggestRoleMappings(
  columnNames: string[],
  roles: DataRoleDef[],
  existing: Record<string, RoleMapping> = {},
): Record<string, RoleMapping> {
  const out: Record<string, RoleMapping> = {}
  for (const role of roles) {
    out[role.id] = suggestRoleMapping(columnNames, role, existing[role.id])
  }
  return out
}

export function roleMappingColumns(mapping?: RoleMapping | null, multi = false): string[] {
  if (!mapping) return []
  if (multi) return mapping.columns?.filter(Boolean) ?? (mapping.column ? [mapping.column] : [])
  return mapping.column ? [mapping.column] : mapping.columns?.filter(Boolean) ?? []
}
