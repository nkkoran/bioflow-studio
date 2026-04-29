import type {
  FileNodeData,
  PipelineSnapshot,
  ToolNodeData,
  TransformNodeData,
} from '@/types/pipeline'
import type {
  DataRoleDef,
  FileProbeResult,
  PortContract,
  RoleMapping,
  WorkflowReadinessIssue,
  WorkflowReadinessReport,
} from '@/types/readiness'
import type { ValidationIssue, ValidationResult } from '@/lib/pipelineValidator'
import { getTool } from '@/lib/toolRegistry'
import { connectedInputSchema, outputSchema, type SchemaCache } from '@/lib/schemaResolver'
import { suggestRoleMapping } from '@/lib/roleMappings'
import { getActiveToolInputs } from '@/lib/analysisOptions'
import { getTransformPreset, transformPresetOutputSchema } from '@/lib/transformPresets'

interface ReadinessOptions {
  probes?: Record<string, FileProbeResult>
}

type ReadinessNode = PipelineSnapshot['nodes'][number]

function probeKey(path: string): string {
  return path
}

function toSchemaCache(probes: Record<string, FileProbeResult>): SchemaCache {
  const out: SchemaCache = {}
  for (const probe of Object.values(probes)) {
    if (!probe.path || !probe.header?.length || !probe.delimiter) continue
    out[probe.path] = {
      columns: probe.header,
      delimiter: probe.delimiter,
      fetchedAt: Date.now(),
      modified: probe.modified,
    }
  }
  return out
}

function selectedParamColumns(raw: unknown, multi = false): string[] {
  if (raw === undefined || raw === null || raw === '') return []
  if (Array.isArray(raw)) return raw.map(String).map((value) => value.trim()).filter(Boolean)
  return String(raw)
    .split(multi ? /[,\s]+/ : /,/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function sourceEdge(snapshot: PipelineSnapshot, nodeId: string, portId: string) {
  return snapshot.edges.find((edge) => edge.target === nodeId && (edge.targetHandle ?? 'input') === portId)
}

function sourceNode(snapshot: PipelineSnapshot, nodeId: string, portId: string): ReadinessNode | null {
  const edge = sourceEdge(snapshot, nodeId, portId)
  if (!edge) return null
  return snapshot.nodes.find((node) => node.id === edge.source) ?? null
}

function sourceFilePath(snapshot: PipelineSnapshot, nodeId: string, portId: string): string | null {
  const upstream = sourceNode(snapshot, nodeId, portId)
  if (!upstream) return null
  if (upstream.type === 'file') return (upstream.data as FileNodeData).path || null
  if (upstream.type === 'transform') return sourceFilePath(snapshot, upstream.id, 'input')
  if (upstream.type === 'merge') return null
  if (upstream.type === 'tool') return null
  return null
}

function fileProbeForPort(
  snapshot: PipelineSnapshot,
  nodeId: string,
  portId: string,
  probes: Record<string, FileProbeResult>,
): FileProbeResult | null {
  const path = sourceFilePath(snapshot, nodeId, portId)
  if (!path) return null
  return probes[probeKey(path)] ?? null
}

function currentRoleMapping(
  nodeData: ToolNodeData | TransformNodeData,
  role: DataRoleDef,
): RoleMapping | null {
  if (role.binding?.kind === 'roleMapping') {
    const roleMappings = nodeData.roleMappings as Record<string, RoleMapping> | undefined
    return roleMappings?.[role.binding.key] ?? null
  }
  if (role.binding?.kind === 'param') {
    const paramValues = (nodeData as ToolNodeData).paramValues ?? {}
    const values = selectedParamColumns(paramValues[role.binding.key], Boolean(role.binding.multi))
    if (values.length === 0) return null
    return {
      roleId: role.id,
      column: values[0],
      columns: role.binding.multi ? values : undefined,
      confirmed: true,
      confidence: 1,
      transform: 'identity',
    }
  }
  return null
}

function roleColumnValues(mapping: RoleMapping, multi = false): string[] {
  if (multi) return mapping.columns?.filter(Boolean) ?? (mapping.column ? [mapping.column] : [])
  return mapping.column ? [mapping.column] : mapping.columns?.filter(Boolean) ?? []
}

function effectiveColumns(
  contract: PortContract | undefined,
  probe: FileProbeResult | null,
  schemaColumns: string[],
): string[] {
  const header = probe?.header?.length ? probe.header : schemaColumns
  if (header.length > 0) return header
  if (contract?.tabular?.requiresHeader === false && (probe?.previewRows?.length ?? 0) > 0) {
    const width = Math.max(...(probe?.previewRows ?? []).map((row) => row.length), 0)
    const roleColumns = (contract.tabular.roles ?? []).map((role) => role.binding?.key ?? role.id)
    return Array.from({ length: width }, (_, index) => roleColumns[index] ?? `column_${index + 1}`)
  }
  return schemaColumns
}

function schemaColumnsForPort(snapshot: PipelineSnapshot, nodeId: string, portId: string, schemas: SchemaCache): string[] {
  return connectedInputSchema(snapshot, nodeId, portId, schemas)?.columns ?? []
}

function resolveRoleMappingsForColumns(
  nodeData: ToolNodeData | TransformNodeData,
  roles: DataRoleDef[],
  columns: string[],
): RoleMapping[] {
  return roles.map((role) => {
    const current = currentRoleMapping(nodeData, role)
    if (current?.confirmed && (current.column || (current.columns?.length ?? 0) > 0)) return current
    return suggestRoleMapping(columns, role, current)
  })
}

function getProbeIdsFromRole(
  probe: FileProbeResult | null,
  columns: string[],
  mapping: RoleMapping | undefined,
  multi = false,
): string[] {
  if (!probe) return []
  const mapped = mapping ? roleColumnValues(mapping, multi) : []
  const header = columns
  if (mapped.length > 0 && header.length > 0 && (probe.previewRows?.length ?? 0) > 0) {
    const ids = new Set<string>()
    for (const column of mapped) {
      const idx = header.indexOf(column)
      if (idx < 0) continue
      for (const row of probe.previewRows ?? []) {
        const value = row[idx]
        if (value?.trim()) ids.add(value.trim())
      }
    }
    if (ids.size > 0) return [...ids]
  }
  return probe.sampleIds ?? probe.recordIds ?? []
}

function pushIssue(issues: WorkflowReadinessIssue[], issue: WorkflowReadinessIssue): void {
  issues.push(issue)
}

function checkPortContract(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  portId: string,
  contract: PortContract,
  probes: Record<string, FileProbeResult>,
  schemas: SchemaCache,
  roleMappings: Record<string, RoleMapping[]>,
  issues: WorkflowReadinessIssue[],
): void {
  const nodeData = node.data as ToolNodeData | TransformNodeData
  const probe = fileProbeForPort(snapshot, node.id, portId, probes)
  const schemaColumns = schemaColumnsForPort(snapshot, node.id, portId, schemas)
  const columns = effectiveColumns(contract, probe, schemaColumns)

  if (probe && !probe.exists) {
    pushIssue(issues, {
      severity: 'error',
      blocking: true,
      category: 'Files',
      code: 'READINESS_FILE_MISSING',
      nodeId: node.id,
      portId,
      path: probe.path,
      message: `Input path for "${portId}" does not exist.`,
      suggestion: 'Fix the path, upload the file, or reconnect the input before running.',
    })
    return
  }

  if ((contract.requiresSidecars?.length ?? 0) > 0 && probe?.exists) {
    const missingSidecars = (contract.requiresSidecars ?? []).filter((suffix) => !probe.sidecars?.[suffix])
    if (missingSidecars.length > 0) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'Files',
        code: 'SIDECAR_MISSING',
        nodeId: node.id,
        portId,
        path: probe.path,
        message: `Input "${portId}" is missing required sidecars: ${missingSidecars.join(', ')}.`,
        suggestion: 'Provide the complete fileset expected by this tool before running.',
      })
    }
  }

  if (contract.family === 'plink-fileset' && probe?.exists) {
    const missingSidecars = Object.entries(probe.sidecars ?? {})
      .filter(([, exists]) => !exists)
      .map(([suffix]) => suffix)
    if (missingSidecars.length > 0) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'Files',
        code: 'PLINK_SIDECAR_MISSING',
        nodeId: node.id,
        portId,
        path: probe.path,
        message: `PLINK input is missing required sidecars: ${missingSidecars.join(', ')}.`,
        suggestion: 'Provide a complete BED/BIM/FAM or PGEN/PVAR/PSAM fileset.',
      })
    }
  }

  if ((contract.requiresIndexes?.length ?? 0) > 0 && probe?.exists) {
    const missingIndexes = (contract.requiresIndexes ?? []).filter((suffix) => !probe.indexes?.[suffix])
    if (missingIndexes.length > 0) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'Files',
        code: 'INDEX_MISSING',
        nodeId: node.id,
        portId,
        path: probe.path,
        message: `Input for "${portId}" is missing expected index files: ${missingIndexes.join(', ')}.`,
        suggestion: 'Create the matching index if downstream tools will query by region.',
      })
    }
  }

  if (!contract.tabular) return
  if (contract.tabular.requiresHeader && columns.length === 0) {
    pushIssue(issues, {
      severity: 'error',
      blocking: true,
      category: 'Columns',
      code: 'TABULAR_HEADER_MISSING',
      nodeId: node.id,
      portId,
      path: probe?.path,
      message: `Input "${portId}" needs a readable header row before BioFlow can map required columns.`,
      suggestion: 'Provide a tabular file with a header or convert the file first.',
    })
    return
  }

  if (
    probe?.delimiter
    && (contract.tabular.allowedDelimiters?.length ?? 0) > 0
    && !contract.tabular.allowedDelimiters?.includes(probe.delimiter)
  ) {
    pushIssue(issues, {
      severity: 'error',
      blocking: true,
      category: 'Files',
      code: 'DELIMITER_NOT_ALLOWED',
      nodeId: node.id,
      portId,
      path: probe.path,
      message: `Input "${portId}" uses "${probe.delimiter}" as its delimiter, which this contract does not allow.`,
      suggestion: 'Convert the file to a supported tabular delimiter before running.',
    })
  }

  const mappings = resolveRoleMappingsForColumns(nodeData, contract.tabular.roles ?? [], columns)
  roleMappings[`${node.id}:${portId}`] = mappings
  for (const role of contract.tabular.roles ?? []) {
    const mapping = mappings.find((candidate) => candidate.roleId === role.id)
    const selected = mapping ? roleColumnValues(mapping, Boolean(role.binding?.multi)) : []
    const missing = selected.filter((column) => !columns.includes(column))
    if (missing.length > 0) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'Columns',
        code: 'ROLE_COLUMN_MISSING',
        nodeId: node.id,
        portId,
        path: probe?.path,
        message: `Mapped ${role.label.toLowerCase()} column${missing.length === 1 ? '' : 's'} for "${portId}" do not exist: ${missing.join(', ')}.`,
        suggestion: 'Update the role mapping or refresh the upstream schema.',
      })
      continue
    }
    if (role.required && selected.length === 0) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'Columns',
        code: 'ROLE_REQUIRED',
        nodeId: node.id,
        portId,
        path: probe?.path,
        message: `BioFlow could not resolve the required ${role.label.toLowerCase()} for "${portId}".`,
        suggestion: 'Pick the correct column in the inspector or rename the upstream column.',
      })
    }
  }
}

function checkSampleOverlap(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  probes: Record<string, FileProbeResult>,
  schemas: SchemaCache,
  roleMappings: Record<string, RoleMapping[]>,
  issues: WorkflowReadinessIssue[],
): void {
  const tool = node.type === 'tool' ? getTool((node.data as ToolNodeData).toolId) : null
  const connectedPortIds = snapshot.edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => edge.targetHandle ?? 'input')
  const ports = (tool ? getActiveToolInputs(tool, node.data as ToolNodeData, { connectedPortIds }) : []).filter((port) => {
    if (port.contract?.family === 'plink-fileset') return true
    return (port.contract?.tabular?.sampleIdRoleIds?.length ?? 0) > 0
  }) ?? []
  if (ports.length < 2) return

  const samplesByPort = new Map<string, Set<string>>()
  for (const port of ports) {
    const probe = fileProbeForPort(snapshot, node.id, port.id, probes)
    const mappings = roleMappings[`${node.id}:${port.id}`] ?? []
    const columns = effectiveColumns(port.contract, probe, schemaColumnsForPort(snapshot, node.id, port.id, schemas))
    const sampleRoleId = port.contract?.tabular?.sampleIdRoleIds?.find((roleId) => roleId === 'sample_id') ?? 'sample_id'
    const mapping = mappings.find((candidate) => candidate.roleId === sampleRoleId)
    const ids = getProbeIdsFromRole(probe, columns, mapping)
    if (ids.length > 0) samplesByPort.set(port.id, new Set(ids))
  }

  const entries = [...samplesByPort.entries()]
  for (let i = 0; i < entries.length; i++) {
    const [basePort, baseIds] = entries[i]
    for (const [otherPort, otherIds] of entries.slice(i + 1)) {
      const overlap = [...baseIds].filter((id) => otherIds.has(id))
      if (overlap.length === 0) {
        pushIssue(issues, {
          severity: 'error',
          blocking: true,
          category: 'IDs',
          code: 'SAMPLE_OVERLAP_ZERO',
          nodeId: node.id,
          message: `Inputs "${basePort}" and "${otherPort}" do not appear to share any sample IDs.`,
          suggestion: 'Check ID columns, keep files, and whether the same cohort/sample naming scheme is being used.',
        })
      } else if (overlap.length < Math.min(baseIds.size, otherIds.size)) {
        pushIssue(issues, {
          severity: 'warning',
          blocking: false,
          category: 'IDs',
          code: 'SAMPLE_OVERLAP_PARTIAL',
          nodeId: node.id,
          message: `Inputs "${basePort}" and "${otherPort}" only partially overlap on sample IDs (${overlap.length} shared in preview).`,
          suggestion: 'If this is unexpected, review ID formatting and cohort filters before running.',
        })
      }
    }
  }
}

function checkParameterRules(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  probes: Record<string, FileProbeResult>,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const tool = getTool((node.data as ToolNodeData).toolId)
  if (!tool) return
  const data = node.data as ToolNodeData
  for (const rule of tool.parameterRules ?? []) {
    const raw = rule.whenParam ? data.paramValues?.[rule.whenParam] : undefined
    const active = rule.whenParam
      ? (rule.equals !== undefined ? raw === rule.equals : !(raw === undefined || raw === null || raw === '' || raw === false))
      : true
    if (!active) continue

    for (const portId of rule.requiresPortsWithIndexes ?? []) {
      const probe = fileProbeForPort(snapshot, node.id, portId, probes)
      const connected = snapshot.edges.filter((edge) => edge.target === node.id).map((edge) => edge.targetHandle ?? 'input')
      const port = getActiveToolInputs(tool, data, { connectedPortIds: connected }).find((candidate) => candidate.id === portId)
      const missingIndexes = (port?.contract?.requiresIndexes ?? []).filter((suffix) => !probe?.indexes?.[suffix])
      if (missingIndexes.length > 0) {
        pushIssue(issues, {
          severity: 'error',
          blocking: true,
          category: 'Files',
          code: 'PARAM_RULE_INDEX_REQUIRED',
          nodeId: node.id,
          portId,
          path: probe?.path,
          message: rule.message,
          suggestion: rule.suggestion ?? `Create the required index files (${missingIndexes.join(', ')}) before running.`,
        })
      }
    }

    const conflicts = (rule.conflictsWithParams ?? []).filter((paramName) => {
      const value = data.paramValues?.[paramName]
      return !(value === undefined || value === null || value === '' || value === false)
    })
    if (conflicts.length > 0) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'Parameters',
        code: 'PARAM_RULE_CONFLICT',
        nodeId: node.id,
        message: rule.message,
        suggestion: rule.suggestion,
      })
    }
  }
}

function rowsForProbe(columns: string[], probe: FileProbeResult | null): Array<Record<string, string>> {
  if (!probe?.previewRows?.length || columns.length === 0) return []
  return probe.previewRows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ''])))
}

function checkTransformPreset(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  probes: Record<string, FileProbeResult>,
  schemas: SchemaCache,
  roleMappings: Record<string, RoleMapping[]>,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'transform') return
  const data = node.data as TransformNodeData
  const preset = getTransformPreset(data.preset)
  if (!preset) return
  const probe = fileProbeForPort(snapshot, node.id, 'input', probes)
  const columns = effectiveColumns(undefined, probe, schemaColumnsForPort(snapshot, node.id, 'input', schemas))
  const mappings = resolveRoleMappingsForColumns(data, preset.roles, columns)
  roleMappings[node.id] = mappings

  for (const role of preset.roles) {
    const mapping = mappings.find((candidate) => candidate.roleId === role.id)
    const selected = mapping ? roleColumnValues(mapping, Boolean(role.binding?.multi)) : []
    if (role.required && selected.length === 0) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'Columns',
        code: 'TRANSFORM_ROLE_REQUIRED',
        nodeId: node.id,
        path: probe?.path,
        message: `${preset.label} needs a ${role.label.toLowerCase()} mapping before it can run.`,
        suggestion: 'Choose the matching input column in the transform preset section.',
      })
      continue
    }
    const missing = selected.filter((column) => !columns.includes(column))
    if (missing.length > 0) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'Columns',
        code: 'TRANSFORM_ROLE_COLUMN_MISSING',
        nodeId: node.id,
        path: probe?.path,
        message: `${preset.label} references missing mapped column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
        suggestion: 'Refresh the input schema or update the preset role mappings.',
      })
    }
  }

  const previewRows = rowsForProbe(columns, probe)
  if (data.preset === 'cohort-filter') {
    const matchValue = String(data.presetConfig?.matchValue ?? '').trim()
    if (!matchValue) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'Parameters',
        code: 'COHORT_VALUE_MISSING',
        nodeId: node.id,
        message: 'Cohort Filter needs a cohort value to match.',
        suggestion: 'Enter the target cohort value, such as EUR.',
      })
    }
    const cohortColumn = mappings.find((candidate) => candidate.roleId === 'cohort')?.column
    if (cohortColumn && matchValue && previewRows.length > 0) {
      const matching = previewRows.filter((row) => row[cohortColumn] === matchValue)
      if (matching.length === 0) {
        pushIssue(issues, {
          severity: 'warning',
          blocking: false,
          category: 'Outputs',
          code: 'COHORT_FILTER_EMPTY_PREVIEW',
          nodeId: node.id,
          path: probe?.path,
          message: `No preview rows matched cohort value "${matchValue}".`,
          suggestion: 'Check the cohort column mapping, capitalization, and whether this value appears in the input.',
        })
      }
    }
  }

  if (data.preset === 'gwas-pval-filter') {
    const threshold = Number(data.presetConfig?.threshold ?? Number.NaN)
    if (!Number.isFinite(threshold)) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'Parameters',
        code: 'PVAL_THRESHOLD_INVALID',
        nodeId: node.id,
        message: 'GWAS P-value Filter needs a numeric threshold.',
        suggestion: 'Enter a threshold such as 5e-8.',
      })
    }
    const pValueColumn = mappings.find((candidate) => candidate.roleId === 'p_value')?.column
    if (pValueColumn && Number.isFinite(threshold) && previewRows.length > 0) {
      const passing = previewRows.filter((row) => Number(row[pValueColumn]) <= threshold)
      if (passing.length === 0) {
        pushIssue(issues, {
          severity: 'warning',
          blocking: false,
          category: 'Outputs',
          code: 'PVAL_FILTER_EMPTY_PREVIEW',
          nodeId: node.id,
          path: probe?.path,
          message: `No preview variants passed the p-value threshold (${threshold}).`,
          suggestion: 'If this is unexpected, confirm the p-value column mapping and threshold before running.',
        })
      }
    }
  }

  if (data.preset === 'clump-lead-list') {
    const variantColumn = mappings.find((candidate) => candidate.roleId === 'variant_id')?.column
    if (variantColumn && previewRows.length > 0 && !previewRows.some((row) => row[variantColumn]?.trim())) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'Outputs',
        code: 'CLUMP_LEADS_EMPTY_PREVIEW',
        nodeId: node.id,
        path: probe?.path,
        message: 'No lead-variant IDs were found in the preview rows for this clump lead list.',
        suggestion: 'Check that the selected variant column matches the clump report output.',
      })
    }
  }

  if (data.preset === 'plink-score-file') {
    const weightColumn = mappings.find((candidate) => candidate.roleId === 'weight')?.column
    const weightTransform = String(data.presetConfig?.weightTransform ?? 'identity')
    if (weightTransform === 'identity' && weightColumn && /(^|_)(or|odds_ratio)($|_)/i.test(weightColumn)) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'Handoffs',
        code: 'SCORE_WEIGHT_OR_IDENTITY',
        nodeId: node.id,
        path: probe?.path,
        message: 'The score-file builder is using an OR column without log-transforming it.',
        suggestion: 'Switch weight transform to log(OR) if this column contains odds ratios rather than betas.',
      })
    }
    if (weightTransform === 'log' && weightColumn && previewRows.length > 0) {
      const invalid = previewRows.some((row) => {
        const value = Number(row[weightColumn])
        return !Number.isFinite(value) || value <= 0
      })
      if (invalid) {
        pushIssue(issues, {
          severity: 'warning',
          blocking: false,
          category: 'Parameters',
          code: 'SCORE_WEIGHT_LOG_INVALID',
          nodeId: node.id,
          path: probe?.path,
          message: 'The score-file builder is set to log-transform weights, but preview rows include non-positive or non-numeric values.',
          suggestion: 'Choose the correct weight column or use identity transform if the column already contains betas/log-OR values.',
        })
      }
    }
  }
}

function isRunnable(node: ReadinessNode): boolean {
  return node.type === 'tool' || node.type === 'merge' || node.type === 'transform'
}

function checkTerminalOutputs(snapshot: PipelineSnapshot, issues: WorkflowReadinessIssue[]): void {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const terminal = snapshot.nodes.filter((node) => {
    if (!isRunnable(node)) return false
    return !snapshot.edges.some((edge) => {
      if (edge.source !== node.id) return false
      const target = nodeById.get(edge.target)
      return Boolean(target && isRunnable(target))
    })
  })

  if (terminal.length === 0) return

  const exported = terminal.some((node) => snapshot.edges.some((edge) => {
    if (edge.source !== node.id) return false
    const target = nodeById.get(edge.target)
    return target?.type === 'file' && !(target.data as FileNodeData).isInput
  }))

  if (!exported) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'Export',
      code: 'FINAL_OUTPUT_NOT_EXPORTED',
      message: 'No terminal workflow outputs are currently connected to output file nodes.',
      suggestion: 'Add output file sinks for the final results you want to keep and export.',
    })
  }
}

export function evaluateWorkflowReadiness(
  snapshot: PipelineSnapshot,
  opts: ReadinessOptions = {},
): WorkflowReadinessReport {
  const probes = opts.probes ?? {}
  const issues: WorkflowReadinessIssue[] = []
  const roleMappings: Record<string, RoleMapping[]> = {}
  const schemas = toSchemaCache(probes)

  for (const node of snapshot.nodes) {
    if (node.type === 'tool') {
      const tool = getTool((node.data as ToolNodeData).toolId)
      if (!tool) continue
      const connected = snapshot.edges.filter((edge) => edge.target === node.id).map((edge) => edge.targetHandle ?? 'input')
      for (const port of getActiveToolInputs(tool, node.data as ToolNodeData, { connectedPortIds: connected })) {
        if (port.contract) {
          checkPortContract(snapshot, node, port.id, port.contract, probes, schemas, roleMappings, issues)
        }
      }
      checkSampleOverlap(snapshot, node, probes, schemas, roleMappings, issues)
      checkParameterRules(snapshot, node, probes, issues)
    } else if (node.type === 'transform') {
      checkTransformPreset(snapshot, node, probes, schemas, roleMappings, issues)
    }
  }

  checkTerminalOutputs(snapshot, issues)

  const blockingCount = issues.filter((issue) => issue.blocking && issue.severity === 'error').length
  return {
    ok: blockingCount === 0,
    blockingCount,
    issueCount: issues.length,
    issues,
    probes,
    roleMappings,
  }
}

export function mergeReadinessIntoValidation(
  base: ValidationResult,
  report: WorkflowReadinessReport,
): ValidationResult {
  const readinessIssues: ValidationIssue[] = report.issues.map((issue) => ({
    severity: issue.severity,
    nodeId: issue.nodeId,
    portId: issue.portId,
    code: issue.code,
    message: issue.message,
    suggestion: issue.suggestion,
  }))
  const issues = [...base.issues, ...readinessIssues]
  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    issues,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    infoCount: issues.filter((issue) => issue.severity === 'info').length,
  }
}

export function transformOutputSchema(
  snapshot: PipelineSnapshot,
  nodeId: string,
  probes: Record<string, FileProbeResult> = {},
): ReturnType<typeof transformPresetOutputSchema> {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node || node.type !== 'transform') return null
  const schemas = toSchemaCache(probes)
  const upstreamColumns = connectedInputSchema(snapshot, nodeId, 'input', schemas)?.columns
    ?? outputSchema(snapshot, nodeId, 'output', schemas)?.columns
    ?? []
  return transformPresetOutputSchema(node.data as TransformNodeData, upstreamColumns)
}
