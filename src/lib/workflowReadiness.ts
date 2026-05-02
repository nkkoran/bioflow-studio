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
import { getActiveToolInputs, getEnabledAnalysisOptions } from '@/lib/analysisOptions'
import { getTransformPreset, transformPresetOutputSchema } from '@/lib/transformPresets'
import { estimateResources } from '@/lib/resourceEstimator'

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

function safeSplitItems(split: FileNodeData['split'] | undefined): Array<{ key: string; path: string }> {
  const raw = split?.items
  return Array.isArray(raw)
    ? raw.filter((item): item is { key: string; path: string } => (
      Boolean(item)
      && typeof item.key === 'string'
      && typeof item.path === 'string'
      && item.path.trim().length > 0
    ))
    : []
}

function sourceFilePaths(snapshot: PipelineSnapshot, nodeId: string, portId: string): string[] {
  const upstream = sourceNode(snapshot, nodeId, portId)
  if (!upstream) return []
  if (upstream.type === 'file') {
    const data = upstream.data as FileNodeData
    const splitItems = safeSplitItems(data.split)
    if (splitItems.length > 0) return splitItems.map((item) => item.path).filter(Boolean)
    return data.path ? [data.path] : []
  }
  if (upstream.type === 'transform') return sourceFilePaths(snapshot, upstream.id, 'input')
  return []
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

function fileProbesForPort(
  snapshot: PipelineSnapshot,
  nodeId: string,
  portId: string,
  probes: Record<string, FileProbeResult>,
): FileProbeResult[] {
  return sourceFilePaths(snapshot, nodeId, portId)
    .map((path) => probes[probeKey(path)])
    .filter((probe): probe is FileProbeResult => Boolean(probe))
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
          message: `Inputs "${basePort}" and "${otherPort}" do not share sample IDs in the preview sample.`,
          suggestion: 'Check ID columns, keep files, and whether the same cohort/sample naming scheme is being used.',
        })
      } else if (overlap.length < Math.min(baseIds.size, otherIds.size) && basePort !== 'keep' && otherPort !== 'keep') {
        pushIssue(issues, {
          severity: 'info',
          blocking: false,
          category: 'IDs',
          code: 'SAMPLE_OVERLAP_PREVIEW_PARTIAL',
          nodeId: node.id,
          message: `Previewed sample IDs for "${basePort}" and "${otherPort}" are not identical (${overlap.length} shared among the previewed IDs).`,
          suggestion: 'This can be normal when files have missing values, filters, or different row order; BioFlow only checked the preview sample.',
        })
      }
    }
  }
}

function checkPlinkPhenotypeCoding(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  connectedPortIds: string[],
  probes: Record<string, FileProbeResult>,
  schemas: SchemaCache,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (!tool || (tool.id !== 'plink2.assoc' && tool.id !== 'plink2.phewas')) return
  const oneEnabled = plinkFlagEnabled(tool, data, connectedPortIds, 'one')

  const probe = fileProbeForPort(snapshot, node.id, 'pheno', probes)
  if (!probe?.previewRows?.length) return
  const columns = effectiveColumns(
    tool.inputs.find((port) => port.id === 'pheno')?.contract,
    probe,
    schemaColumnsForPort(snapshot, node.id, 'pheno', schemas),
  )
  if (columns.length === 0) return

  const selectedColumns = selectedParamColumns(
    tool.id === 'plink2.phewas' ? data.paramValues?.phenotypes : data.paramValues?.['pheno-name'],
    true,
  )
  for (const column of selectedColumns) {
    const idx = columns.indexOf(column)
    if (idx < 0) continue
    const values = normalizedPhenotypePreviewValues(probe.previewRows, idx)
    if (values.observed < 6) continue
    const valueSet = new Set(values.values)
    const looksZeroOne = valueSet.size > 0 && [...valueSet].every((value) => value === '0' || value === '1')
    if (looksZeroOne && !oneEnabled) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'IDs',
        code: 'PLINK_BINARY_PHENO_01_NEEDS_ONE',
        nodeId: node.id,
        portId: 'pheno',
        path: probe.path,
        message: `Phenotype "${column}" looks 0/1-coded in the preview. PLINK2 treats 1 as control and 2 as case unless --1 is enabled.`,
        suggestion: 'Enable --1 for this PLINK node when 0=control and 1=case; otherwise PLINK can report 0 cases.',
        details: quickFixDetails('one', true, 'Enable --1'),
      })
      return
    }
    const balance = binaryCaseControlBalance(values.values, oneEnabled)
    if (!balance) continue
    if (balance.cases === 0 || balance.controls === 0) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'IDs',
        code: 'PLINK_BINARY_PHENO_EMPTY_CLASS_PREVIEW',
        nodeId: node.id,
        portId: 'pheno',
        path: probe.path,
        message: `Phenotype "${column}" has ${balance.cases} preview cases and ${balance.controls} preview controls under the current PLINK coding.`,
        suggestion: oneEnabled
          ? 'Confirm this phenotype has both classes after filtering; otherwise choose a different outcome or cohort.'
          : 'If this is a 0/1 phenotype, enable --1; otherwise confirm the phenotype uses PLINK 1/2 case-control coding.',
        details: oneEnabled ? undefined : quickFixDetails('one', true, 'Enable --1'),
      })
      return
    }
  }
}

function normalizedPhenotypePreviewValues(rows: string[][], columnIndex: number): { values: string[]; observed: number } {
  const values: string[] = []
  for (const row of rows) {
    const raw = row[columnIndex]?.trim()
    if (!raw || /^na$/i.test(raw) || /^nan$/i.test(raw) || raw === '-9') continue
    const numeric = Number(raw)
    if (Number.isFinite(numeric) && Number.isInteger(numeric)) values.push(String(numeric))
    else values.push(raw)
  }
  return { values, observed: values.length }
}

function checkPlinkTableModifiers(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  connectedPortIds: string[],
  probes: Record<string, FileProbeResult>,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (!tool || (tool.id !== 'plink2.assoc' && tool.id !== 'plink2.phewas')) return
  for (const portId of ['pheno', 'covar'] as const) {
    if (!connectedPortIds.includes(portId)) continue
    const probe = fileProbeForPort(snapshot, node.id, portId, probes)
    if (!probe?.header?.length) continue
    const lower = probe.header.map((column) => column.trim().toLowerCase())
    const hasFid = lower.includes('fid') || lower.includes('family_id') || lower.includes('familyid')
    const hasIid = lower.includes('iid') || lower.includes('sample_id') || lower.includes('sampleid') || lower.includes('id')
    const flagId = `${portId}-iid-only`
    if (hasFid && plinkFlagEnabled(tool, data, connectedPortIds, flagId)) {
      pushIssue(issues, {
        severity: 'error',
        blocking: true,
        category: 'IDs',
        code: `PLINK_${portId.toUpperCase()}_IID_ONLY_WITH_FID`,
        nodeId: node.id,
        portId,
        path: probe.path,
        message: `The ${portId} file has a FID column, but --${portId} iid-only is enabled.`,
        suggestion: `Disable the PLINK iid-only modifier for --${portId}; PLINK rejects iid-only when FID is present.`,
        details: quickFixDetails(flagId, false, `Disable --${portId} iid-only`),
      })
      continue
    }
    if (!hasFid && hasIid && !plinkFlagEnabled(tool, data, connectedPortIds, flagId)) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'IDs',
        code: `PLINK_${portId.toUpperCase()}_IID_ONLY`,
        nodeId: node.id,
        portId,
        path: probe.path,
        message: `The ${portId} file appears to have IID/sample IDs but no FID column.`,
        suggestion: `Enable the PLINK iid-only modifier for --${portId}, or provide both FID and IID columns.`,
        details: quickFixDetails(flagId, true, `Enable --${portId} iid-only`),
      })
    }
  }
}

function checkPlinkNoCovars(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  connectedPortIds: string[],
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (!tool || (tool.id !== 'plink2.assoc' && tool.id !== 'plink2.phewas')) return
  const hasCovarInput = Boolean(sourceEdge(snapshot, node.id, 'covar'))
  const covarNames = selectedParamColumns(data.paramValues?.['covar-name'], true)
  if (!hasCovarInput && covarNames.length === 0 && !plinkFlagEnabled(tool, data, connectedPortIds, 'allow-no-covars')) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'Parameters',
      code: 'PLINK_GLM_NO_COVARS_NEEDS_FLAG',
      nodeId: node.id,
      message: 'PLINK --glm is configured without covariates.',
      suggestion: 'Enable allow-no-covars for an intentionally unadjusted model, or connect a covariate file.',
      details: quickFixDetails('allow-no-covars', true, 'Enable allow-no-covars'),
    })
  }
}

function checkPlinkNeg9Phenotypes(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  connectedPortIds: string[],
  probes: Record<string, FileProbeResult>,
  schemas: SchemaCache,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (!tool || (tool.id !== 'plink2.assoc' && tool.id !== 'plink2.phewas')) return
  if (
    plinkFlagEnabled(tool, data, connectedPortIds, 'neg9-pheno-really-missing')
    || plinkFlagEnabled(tool, data, connectedPortIds, 'no-input-missing-phenotype')
    || Boolean(data.paramValues?.['input-missing-phenotype'])
  ) return

  const checks: Array<{ portId: 'pheno' | 'covar'; params: string[] }> = [
    { portId: 'pheno', params: selectedParamColumns(tool.id === 'plink2.phewas' ? data.paramValues?.phenotypes : data.paramValues?.['pheno-name'], true) },
    { portId: 'covar', params: selectedParamColumns(data.paramValues?.['covar-name'], true) },
  ]
  for (const { portId, params } of checks) {
    const probe = fileProbeForPort(snapshot, node.id, portId, probes)
    if (!probe?.previewRows?.length || params.length === 0) continue
    const columns = effectiveColumns(
      tool.inputs.find((port) => port.id === portId)?.contract,
      probe,
      schemaColumnsForPort(snapshot, node.id, portId, schemas),
    )
    for (const column of params) {
      const idx = columns.indexOf(column)
      if (idx < 0) continue
      const values = numericPreviewValues(probe.previewRows, idx)
      const hasNeg9 = values.some((value) => value === -9)
      const nearNeg9 = values.some((value) => value > -10 && value < -8 && value !== -9)
      if (hasNeg9 && nearNeg9) {
        pushIssue(issues, {
          severity: 'warning',
          blocking: false,
          category: 'Parameters',
          code: 'PLINK_NEG9_PHENO_AMBIGUOUS',
          nodeId: node.id,
          portId,
          path: probe.path,
          message: `Column "${column}" contains -9 and nearby numeric values in the preview.`,
          suggestion: 'If -9 is truly missing, confirm it with --neg9-pheno-really-missing; if -9 is numeric, use --no-input-missing-phenotype.',
          details: quickFixDetails('neg9-pheno-really-missing', true, 'Confirm -9 missing'),
        })
        return
      }
    }
  }
}

function checkPlinkKeepFileShape(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  probes: Record<string, FileProbeResult>,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const tool = getTool((node.data as ToolNodeData).toolId)
  if (!tool?.id.startsWith('plink2.')) return
  const probe = fileProbeForPort(snapshot, node.id, 'keep', probes)
  if (!probe?.previewRows?.length) return
  const narrow = probe.previewRows.some((row) => row.filter((cell) => cell.trim()).length < 2)
  if (!narrow) return
  pushIssue(issues, {
    severity: 'warning',
    blocking: false,
    category: 'Files',
    code: 'PLINK_KEEP_FILE_SHAPE',
    nodeId: node.id,
    portId: 'keep',
    path: probe.path,
    message: 'The connected keep file has preview rows with fewer than two ID columns.',
    suggestion: 'PLINK keep files should normally contain FID and IID columns. Convert one-column IID lists before running.',
  })
}

function checkPlinkVariantPreview(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  connectedPortIds: string[],
  probes: Record<string, FileProbeResult>,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (!tool?.id.startsWith('plink2.')) return
  const probe = fileProbeForPort(snapshot, node.id, 'input', probes)
  const variants = variantRowsForProbe(probe)
  if (!variants) return
  const rows = variants.rows.slice(0, 200)
  const idIdx = variantColumnIndex(variants.header, ['ID', 'SNP', 'RSID'])
  const chromIdx = variantColumnIndex(variants.header, ['#CHROM', 'CHROM', 'CHR'])
  const refIdx = variantColumnIndex(variants.header, ['REF', 'A2'])
  const altIdx = variantColumnIndex(variants.header, ['ALT', 'A1'])
  if (idIdx >= 0) {
    const ids = rows.map((row) => row[idIdx]?.trim()).filter(Boolean)
    const duplicate = firstDuplicate(ids)
    if (duplicate && !plinkFlagEnabled(tool, data, connectedPortIds, 'rm-dup')) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'Files',
        code: 'PLINK_DUPLICATE_VARIANT_IDS',
        nodeId: node.id,
        portId: 'input',
        path: probe?.path,
        message: `Variant preview contains duplicate ID "${duplicate}".`,
        suggestion: 'Review duplicate variants or use PLINK --rm-dup exclude-mismatch when dropping mismatching duplicates is acceptable.',
        details: quickFixDetails('rm-dup', 'exclude-mismatch', 'Enable --rm-dup'),
      })
    }
    if (ids.some((id) => id === '.') && !plinkFlagEnabled(tool, data, connectedPortIds, 'set-all-var-ids')) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'Files',
        code: 'PLINK_MISSING_VARIANT_IDS',
        nodeId: node.id,
        portId: 'input',
        path: probe?.path,
        message: 'Variant preview contains missing "." variant IDs.',
        suggestion: 'Use --set-all-var-ids to assign stable chromosome/position/allele IDs before PLINK steps that need unique IDs.',
        details: quickFixDetails('set-all-var-ids', '@:#$r,$a', 'Enable --set-all-var-ids'),
      })
    }
  }
  if (altIdx >= 0 && rows.some((row) => row[altIdx]?.includes(',')) && !plinkFlagEnabled(tool, data, connectedPortIds, 'max-alleles')) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'Files',
      code: 'PLINK_MULTIALLELIC_VARIANTS',
      nodeId: node.id,
      portId: 'input',
      path: probe?.path,
      message: 'Variant preview includes multiallelic ALT values.',
      suggestion: 'If this PLINK step expects biallelic variants, restrict to --max-alleles 2 or split multiallelic records upstream.',
      details: quickFixDetails('max-alleles', 2, 'Enable --max-alleles 2'),
    })
  }
  if (refIdx >= 0 && altIdx >= 0 && rows.some((row) => !isSimpleSnpAllele(row[refIdx]) || !isSimpleSnpAllele(row[altIdx])) && !plinkFlagEnabled(tool, data, connectedPortIds, 'snps-only')) {
    pushIssue(issues, {
      severity: 'info',
      blocking: false,
      category: 'Files',
      code: 'PLINK_NON_SNP_VARIANTS',
      nodeId: node.id,
      portId: 'input',
      path: probe?.path,
      message: 'Variant preview includes non-SNP or non-ACGT alleles.',
      suggestion: 'If downstream steps expect SNPs only, use --snps-only just-acgt.',
      details: quickFixDetails('snps-only', 'just-acgt', 'Enable --snps-only'),
    })
  }
  if (chromIdx >= 0) {
    const chroms = rows.map((row) => normalizeChrom(row[chromIdx])).filter(Boolean)
    const nonstandard = chroms.find((chrom) => !isStandardHumanChrom(chrom))
    if (nonstandard && !plinkFlagEnabled(tool, data, connectedPortIds, 'allow-extra-chr')) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'Files',
        code: 'PLINK_EXTRA_CHROMOSOMES',
        nodeId: node.id,
        portId: 'input',
        path: probe?.path,
        message: `Variant preview includes nonstandard chromosome "${nonstandard}".`,
        suggestion: 'If these contigs are expected, enable --allow-extra-chr; otherwise check chromosome naming.',
        details: quickFixDetails('allow-extra-chr', true, 'Enable --allow-extra-chr'),
      })
    }
    if (chroms.some((chrom) => chrom === 'X')) {
      pushIssue(issues, {
        severity: 'info',
        blocking: false,
        category: 'Files',
        code: 'PLINK_CHRX_PAR_REVIEW',
        nodeId: node.id,
        portId: 'input',
        path: probe?.path,
        message: 'Variant preview includes chromosome X.',
        suggestion: 'For chrX association, confirm sex metadata and PAR handling before running large jobs.',
      })
    }
  }
}

function checkPlinkScoreReadiness(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  connectedPortIds: string[],
  probes: Record<string, FileProbeResult>,
  schemas: SchemaCache,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (tool?.id !== 'plink2.score') return
  const scoreProbe = fileProbeForPort(snapshot, node.id, 'score', probes)
  if (!scoreProbe?.previewRows?.length) return
  const columns = effectiveColumns(tool.inputs.find((port) => port.id === 'score')?.contract, scoreProbe, schemaColumnsForPort(snapshot, node.id, 'score', schemas))
  const headerLooksReal = columns.some((column) => ['id', 'snp', 'rsid', 'a1', 'allele', 'effect_allele', 'beta', 'or', 'score'].includes(column.trim().toLowerCase()))
  const headerEnabled = plinkFlagEnabled(tool, data, connectedPortIds, 'header')
  if (headerLooksReal && !headerEnabled) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'Parameters',
      code: 'PLINK_SCORE_HEADER_DISABLED',
      nodeId: node.id,
      portId: 'score',
      path: scoreProbe.path,
      message: 'The score file preview looks like it has a header, but PLINK score header mode is off.',
      suggestion: 'Enable score header so PLINK does not treat column names as a variant row.',
      details: quickFixDetails('header', true, 'Enable score header'),
    })
  }
  if (!headerLooksReal && headerEnabled) {
    pushIssue(issues, {
      severity: 'info',
      blocking: false,
      category: 'Parameters',
      code: 'PLINK_SCORE_HEADER_UNCLEAR',
      nodeId: node.id,
      portId: 'score',
      path: scoreProbe.path,
      message: 'Score header mode is on, but the first row does not look like standard score-file column names.',
      suggestion: 'Confirm the score file has a header; otherwise disable score header or provide column numbers explicitly.',
    })
  }

  const expectedCols = scoreColumnNumsFromRoles(columns)
  const currentCols = scoreColumnNums(tool, data, connectedPortIds)
  if (expectedCols && currentCols && expectedCols !== currentCols) {
    pushIssue(issues, {
      severity: 'warning',
      blocking: false,
      category: 'Parameters',
      code: 'PLINK_SCORE_COL_NUMS_MISMATCH',
      nodeId: node.id,
      portId: 'score',
      path: scoreProbe.path,
      message: `Score-file columns look like ${expectedCols}, but the node is set to ${currentCols}.`,
      suggestion: 'Use the variant/effect-allele/weight columns inferred from the score-file header.',
      details: quickFixDetails('score-col-nums', expectedCols, `Use columns ${expectedCols}`),
    })
  }

  const scoreIdIdx = firstColumnIndex(columns, ['ID', 'SNP', 'RSID'])
  const scoreAlleleIdx = firstColumnIndex(columns, ['A1', 'ALT', 'ALLELE', 'EFFECT_ALLELE'])
  if (scoreIdIdx >= 0) {
    const scoreIds = scoreProbe.previewRows.map((row) => row[scoreIdIdx]?.trim()).filter(Boolean)
    const duplicate = firstDuplicate(scoreIds)
    if (duplicate && !plinkFlagEnabled(tool, data, connectedPortIds, 'ignore-dup-ids')) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'Files',
        code: 'PLINK_SCORE_DUPLICATE_IDS',
        nodeId: node.id,
        portId: 'score',
        path: scoreProbe.path,
        message: `Score file preview contains duplicate variant ID "${duplicate}".`,
        suggestion: 'Deduplicate the score file, or enable ignore-dup-ids if repeated IDs are expected.',
        details: quickFixDetails('ignore-dup-ids', true, 'Enable ignore-dup-ids'),
      })
    }
  }
  if (scoreIdIdx >= 0 && scoreAlleleIdx >= 0) {
    const genotypeAlleles = alleleMapForProbe(fileProbeForPort(snapshot, node.id, 'input', probes))
    const mismatch = scoreProbe.previewRows.find((row) => {
      const id = row[scoreIdIdx]?.trim()
      const allele = row[scoreAlleleIdx]?.trim().toUpperCase()
      const allowed = id ? genotypeAlleles.get(id) : undefined
      return Boolean(id && allele && allowed && !allowed.has(allele))
    })
    if (mismatch) {
      pushIssue(issues, {
        severity: 'warning',
        blocking: false,
        category: 'Files',
        code: 'PLINK_SCORE_ALLELE_MISMATCH_PREVIEW',
        nodeId: node.id,
        portId: 'score',
        path: scoreProbe.path,
        message: `Score allele "${mismatch[scoreAlleleIdx]}" for variant "${mismatch[scoreIdIdx]}" is not present in the genotype preview alleles.`,
        suggestion: 'Check score-file build, reference allele orientation, and genome build before scoring.',
      })
    }
  }
}

function checkPlinkCovariatePreview(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  probes: Record<string, FileProbeResult>,
  schemas: SchemaCache,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (!tool || (tool.id !== 'plink2.assoc' && tool.id !== 'plink2.phewas')) return
  const covarNames = selectedParamColumns(data.paramValues?.['covar-name'], true)
  if (covarNames.length < 2) return
  const probe = fileProbeForPort(snapshot, node.id, 'covar', probes)
  if (!probe?.previewRows?.length) return
  const columns = effectiveColumns(tool.inputs.find((port) => port.id === 'covar')?.contract, probe, schemaColumnsForPort(snapshot, node.id, 'covar', schemas))
  for (let i = 0; i < covarNames.length; i++) {
    for (let j = i + 1; j < covarNames.length; j++) {
      const aIdx = columns.indexOf(covarNames[i])
      const bIdx = columns.indexOf(covarNames[j])
      if (aIdx < 0 || bIdx < 0) continue
      const corr = previewCorrelation(probe.previewRows, aIdx, bIdx)
      if (corr !== null && Math.abs(corr) >= 0.999) {
        pushIssue(issues, {
          severity: 'warning',
          blocking: false,
          category: 'Parameters',
          code: 'PLINK_COVARIATE_COLLINEAR_PREVIEW',
          nodeId: node.id,
          portId: 'covar',
          path: probe.path,
          message: `Covariates "${covarNames[i]}" and "${covarNames[j]}" are nearly perfectly correlated in the preview.`,
          suggestion: 'Review covariate selection before running; PLINK may reject singular or near-singular covariate matrices.',
        })
        return
      }
    }
  }
}

function checkPlinkGwasResources(
  snapshot: PipelineSnapshot,
  node: ReadinessNode,
  connectedPortIds: string[],
  probes: Record<string, FileProbeResult>,
  issues: WorkflowReadinessIssue[],
): void {
  if (node.type !== 'tool') return
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (!tool || (tool.id !== 'plink2.assoc' && tool.id !== 'plink2.phewas')) return

  const inputSizes: Record<string, number> = {}
  for (const portId of connectedPortIds) {
    const portProbes = fileProbesForPort(snapshot, node.id, portId, probes)
    if (portProbes.length === 0) continue
    const sizes = portProbes.map((probe) => probe.size ?? 0).filter((size) => size > 0)
    if (sizes.length === 0) continue
    inputSizes[portId] = portProbes.length > 1
      ? Math.max(...sizes)
      : sizes.reduce((sum, size) => sum + size, 0)
  }

  const splitItems = sourceSplitItems(snapshot, node.id, 'input')
  const estimate = estimateResources({
    tool,
    nodeData: data,
    inputSizes,
    isArray: splitItems.length > 0,
    arraySize: splitItems.length || undefined,
    hasFilter: hasPlinkFilterParam(data),
  })

  const effective = {
    cpus: data.slurmOverride?.cpus ?? tool.slurm?.cpus ?? 1,
    memoryGB: data.slurmOverride?.memoryGB ?? tool.slurm?.memoryGB ?? 4,
    timeHours: data.slurmOverride?.timeHours ?? tool.slurm?.timeHours ?? 1,
  }
  const lowCpu = effective.cpus < estimate.cpus
  const lowMem = effective.memoryGB < estimate.memGB
  const lowTime = effective.timeHours < estimate.timeHours
  if (!lowCpu && !lowMem && !lowTime) return

  const current = `${effective.cpus} CPU / ${effective.memoryGB} GB / ${effective.timeHours} h`
  const recommended = `${estimate.cpus} CPU / ${estimate.memGB} GB / ${estimate.timeHours} h`
  pushIssue(issues, {
    severity: 'warning',
    blocking: false,
    category: 'Resources',
    code: 'PLINK_GWAS_RESOURCES_LOW',
    nodeId: node.id,
    message: `PLINK2 GWAS resources look low (${current}); safety recommendation is ${recommended}.`,
    suggestion: 'Apply the safe Slurm resources before running large association jobs to reduce timeout/OOM risk. Lower them only when you know the cohort is small.',
    details: {
      quickFixResourceCpus: estimate.cpus,
      quickFixResourceMemoryGB: estimate.memGB,
      quickFixResourceTimeHours: estimate.timeHours,
      quickFixLabel: 'Apply safe resources',
    },
  })
}

function sourceSplitItems(snapshot: PipelineSnapshot, nodeId: string, portId: string): Array<{ key: string; path: string }> {
  const upstream = sourceNode(snapshot, nodeId, portId)
  if (!upstream || upstream.type !== 'file') return []
  return safeSplitItems((upstream.data as FileNodeData).split)
}

function hasPlinkFilterParam(data: ToolNodeData): boolean {
  const params = data.paramValues ?? {}
  return [
    'maf',
    'geno',
    'hwe',
    'chr',
    'keep',
    'remove',
    'extract',
    'exclude',
    'rm-dup',
    'read-freq',
  ].some((key) => {
    const value = params[key]
    return value !== undefined && value !== null && value !== '' && value !== false
  })
}

function quickFixDetails(flagId: string, value: string | number | boolean, label: string): Record<string, string | number | boolean> {
  return { quickFixFlagId: flagId, quickFixValue: value, quickFixLabel: label }
}

function plinkFlagEnabled(tool: NonNullable<ReturnType<typeof getTool>>, data: ToolNodeData, connectedPortIds: string[], flagId: string): boolean {
  if (data.paramValues?.[flagId] === true) return true
  return getEnabledAnalysisOptions(tool, data, { connectedPortIds }).some((option) => option.optionId === flagId || option.subOptions?.[flagId]?.enabled)
}

function plinkFlagValue(tool: NonNullable<ReturnType<typeof getTool>>, data: ToolNodeData, connectedPortIds: string[], flagId: string): unknown {
  if (data.paramValues?.[flagId] !== undefined) return data.paramValues[flagId]
  for (const option of getEnabledAnalysisOptions(tool, data, { connectedPortIds })) {
    if (option.optionId === flagId) return option.value
    if (option.subOptions?.[flagId]) return option.subOptions[flagId].value
  }
  return undefined
}

function binaryCaseControlBalance(values: string[], oneEnabled: boolean): { cases: number; controls: number } | null {
  const allowed = oneEnabled ? new Set(['0', '1']) : new Set(['1', '2'])
  if (!values.every((value) => allowed.has(value))) return null
  return oneEnabled
    ? { controls: values.filter((value) => value === '0').length, cases: values.filter((value) => value === '1').length }
    : { controls: values.filter((value) => value === '1').length, cases: values.filter((value) => value === '2').length }
}

function numericPreviewValues(rows: string[][], columnIndex: number): number[] {
  return rows
    .map((row) => Number(row[columnIndex]?.trim()))
    .filter((value) => Number.isFinite(value))
}

function variantRowsForProbe(probe: FileProbeResult | null): { header: string[]; rows: string[][] } | null {
  if (!probe) return null
  if ((probe.variantHeader?.length ?? 0) > 0 && (probe.variantPreviewRows?.length ?? 0) > 0) {
    return { header: probe.variantHeader!, rows: probe.variantPreviewRows! }
  }
  if ((probe.header?.length ?? 0) > 0 && (probe.previewRows?.length ?? 0) > 0) {
    return { header: probe.header!, rows: probe.previewRows! }
  }
  return null
}

function variantColumnIndex(header: string[], aliases: string[]): number {
  const normalized = header.map((column) => column.trim().replace(/^#/, '').toUpperCase())
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias.replace(/^#/, '').toUpperCase())
    if (idx >= 0) return idx
  }
  return -1
}

function firstColumnIndex(header: string[], aliases: string[]): number {
  const normalized = header.map((column) => column.trim().toLowerCase())
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias.trim().toLowerCase())
    if (idx >= 0) return idx
  }
  return -1
}

function firstDuplicate(values: string[]): string | null {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return null
}

function isSimpleSnpAllele(value: string | undefined): boolean {
  if (!value) return false
  return /^[ACGT]$/i.test(value.trim())
}

function normalizeChrom(raw: string | undefined): string {
  return String(raw ?? '').trim().replace(/^chr/i, '').toUpperCase()
}

function isStandardHumanChrom(chrom: string): boolean {
  if (/^(?:[1-9]|1[0-9]|2[0-2])$/.test(chrom)) return true
  return chrom === 'X' || chrom === 'Y' || chrom === 'XY' || chrom === 'M' || chrom === 'MT'
}

function scoreColumnNumsFromRoles(columns: string[]): string | null {
  const id = firstColumnIndex(columns, ['ID', 'SNP', 'RSID'])
  const allele = firstColumnIndex(columns, ['A1', 'ALT', 'ALLELE', 'EFFECT_ALLELE'])
  const weight = firstColumnIndex(columns, ['BETA', 'OR', 'LOG_OR', 'SCORE'])
  if (id < 0 || allele < 0 || weight < 0) return null
  return `${id + 1} ${allele + 1} ${weight + 1}`
}

function scoreColumnNums(tool: NonNullable<ReturnType<typeof getTool>>, data: ToolNodeData, connectedPortIds: string[]): string | null {
  const raw = plinkFlagValue(tool, data, connectedPortIds, 'score-col-nums')
  const values = selectedParamColumns(raw ?? '1 2 3', true)
  return values.length > 0 ? values.join(' ') : null
}

function alleleMapForProbe(probe: FileProbeResult | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const variants = variantRowsForProbe(probe)
  if (!variants) return out
  const idIdx = variantColumnIndex(variants.header, ['ID', 'SNP', 'RSID'])
  const refIdx = variantColumnIndex(variants.header, ['REF', 'A2'])
  const altIdx = variantColumnIndex(variants.header, ['ALT', 'A1'])
  if (idIdx < 0 || refIdx < 0 || altIdx < 0) return out
  for (const row of variants.rows) {
    const id = row[idIdx]?.trim()
    if (!id) continue
    const alleles = new Set<string>()
    for (const allele of [row[refIdx], row[altIdx]]) {
      for (const token of String(allele ?? '').split(',')) {
        const value = token.trim().toUpperCase()
        if (value) alleles.add(value)
      }
    }
    out.set(id, alleles)
  }
  return out
}

function previewCorrelation(rows: string[][], aIdx: number, bIdx: number): number | null {
  const pairs = rows
    .map((row) => [Number(row[aIdx]), Number(row[bIdx])] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
  if (pairs.length < 4) return null
  const meanA = pairs.reduce((sum, [a]) => sum + a, 0) / pairs.length
  const meanB = pairs.reduce((sum, [, b]) => sum + b, 0) / pairs.length
  let numerator = 0
  let denomA = 0
  let denomB = 0
  for (const [a, b] of pairs) {
    const da = a - meanA
    const db = b - meanB
    numerator += da * db
    denomA += da * da
    denomB += db * db
  }
  if (denomA === 0 || denomB === 0) return null
  return numerator / Math.sqrt(denomA * denomB)
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
      checkPlinkTableModifiers(snapshot, node, connected, probes, issues)
      checkPlinkNoCovars(snapshot, node, connected, issues)
      checkPlinkPhenotypeCoding(snapshot, node, connected, probes, schemas, issues)
      checkPlinkNeg9Phenotypes(snapshot, node, connected, probes, schemas, issues)
      checkPlinkKeepFileShape(snapshot, node, probes, issues)
      checkPlinkVariantPreview(snapshot, node, connected, probes, issues)
      checkPlinkScoreReadiness(snapshot, node, connected, probes, schemas, issues)
      checkPlinkCovariatePreview(snapshot, node, probes, schemas, issues)
      checkPlinkGwasResources(snapshot, node, connected, probes, issues)
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
    details: issue.details,
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
