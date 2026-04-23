import { create } from 'zustand'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { ClusterDoctorCheck, ClusterDoctorReport, ClusterDoctorStatus } from '@/types/workspace'

interface ClusterDoctorStoreState {
  reports: Record<string, ClusterDoctorReport>
  loadingByConnection: Record<string, boolean>
  runReport: (connectionId: string, options?: { force?: boolean }) => Promise<ClusterDoctorReport>
}

export function doctorReportKey(connectionId: string, workspaceId?: string | null): string {
  return `${connectionId}::${workspaceId ?? 'none'}`
}

function summarizeStatus(exitCode: number, severity: ClusterDoctorCheck['severity']): ClusterDoctorStatus {
  if (exitCode === 0) return 'pass'
  return severity === 'error' ? 'error' : 'warning'
}

async function execCheck(
  connectionId: string,
  check: Omit<ClusterDoctorCheck, 'status' | 'detail'> & { command: string; passDetail: string; failDetail: string },
): Promise<ClusterDoctorCheck> {
  const result = await window.api.ssh.exec(connectionId, check.command)
  return {
    id: check.id,
    title: check.title,
    severity: check.severity,
    status: summarizeStatus(result.exitCode, check.severity),
    detail: result.exitCode === 0 ? check.passDetail : `${check.failDetail}${result.stderr ? `\n${result.stderr.trim()}` : ''}`,
    suggestion: check.suggestion,
  }
}

export const useClusterDoctorStore = create<ClusterDoctorStoreState>((set, get) => ({
  reports: {},
  loadingByConnection: {},

  runReport: async (connectionId, options) => {
    if (!connectionId || connectionId === LOCAL_CONNECTION_ID) {
      return {
        connectionId,
        createdAt: Date.now(),
        checks: [{
          id: 'local-mode',
          title: 'Cluster doctor requires a remote Slurm connection',
          severity: 'error',
          status: 'error',
          detail: 'Switch from Local mode to an SSH cluster connection first.',
          suggestion: 'Connect to Rorqual or another Slurm cluster before running preflight checks.',
        }],
      }
    }

    try {
      const workspaceStore = useWorkspaceStore.getState()
      const workspace = workspaceStore.activeWorkspaceId
        ? workspaceStore.workspaces.find((row) => row.id === workspaceStore.activeWorkspaceId) ?? null
        : null
      const cacheKey = doctorReportKey(connectionId, workspace?.id)
      if (!options?.force && get().reports[cacheKey]) return get().reports[cacheKey]
      set((state) => ({ loadingByConnection: { ...state.loadingByConnection, [cacheKey]: true } }))
      const settings = useSettingsStore.getState().settings
      const connection = useConnectionStore.getState().connections[connectionId]
      const analysisRoot = workspace?.analysisRoot ?? await window.api.store.get<string>(`connection:${connectionId}:defaultAnalysisFolder`) ?? ''
      const slurmAccount = workspace?.slurmAccount ?? await window.api.store.get<string>(`connection:${connectionId}:slurmAccount`) ?? ''
      const toolsRoot = workspace?.toolsRoot ?? settings.toolsRoot
      const annovarScriptsPath = workspace?.annovarScriptsPath ?? settings.annovarScriptsPath
      const annovarDbPath = workspace?.annovarDbPath ?? settings.annovarDbPath
      const vepPath = workspace?.vepPath ?? settings.vepPath
      const vepCachePath = workspace?.vepCachePath ?? settings.vepCachePath
      const homeResult = await window.api.ssh.exec(connectionId, 'printf %s "$HOME"')
      const homeDir = homeResult.stdout.trim()
      const fallbackAnalysisRoot = `${homeDir.replace(/\/+$/, '')}/bioflow`
      const targetFsPath = expandHome(analysisRoot.trim() || fallbackAnalysisRoot, homeDir)
      const authMethod = connection?.config.authMethod ?? 'unknown'
      const resolvedToolsRoot = expandHome(toolsRoot, homeDir)
      const resolvedAnnovarScriptsPath = expandHome(annovarScriptsPath, homeDir)
      const resolvedAnnovarDbPath = expandHome(annovarDbPath, homeDir)
      const resolvedVepPath = expandHome(vepPath, homeDir)
      const resolvedVepCachePath = expandHome(vepCachePath, homeDir)

      const checks: ClusterDoctorCheck[] = [
        {
          id: 'auth-mode',
          title: 'Authentication mode',
          severity: 'info',
          status: 'pass',
          detail: `Connected as ${connection?.config.username ?? 'unknown'} using ${authMethod}.`,
        },
        {
          id: 'home',
          title: 'Remote home directory',
          severity: 'error',
          status: homeResult.exitCode === 0 ? 'pass' : 'error',
          detail: homeResult.exitCode === 0 ? homeDir : (homeResult.stderr.trim() || 'Could not resolve $HOME.'),
          suggestion: homeResult.exitCode === 0 ? undefined : 'Reconnect and verify the cluster account is usable from a login shell.',
        },
        {
          id: 'analysis-root-config',
          title: 'Analysis folder',
          severity: analysisRoot.trim() ? 'info' : 'warning',
          status: 'pass',
          detail: analysisRoot.trim()
            ? `Configured analysis folder: ${expandHome(analysisRoot, homeDir)}`
            : `No analysis folder configured. BioFlow will use the default run root: ${fallbackAnalysisRoot}`,
          suggestion: analysisRoot.trim() ? undefined : 'Set a workspace analysis root if you want runs to land somewhere other than the default ~/bioflow area.',
        },
        {
          id: 'slurm-account-config',
          title: 'Slurm account configured',
          severity: 'error',
          status: slurmAccount.trim() ? 'pass' : 'error',
          detail: slurmAccount.trim() || 'No Slurm account is set for this connection/workspace.',
          suggestion: slurmAccount.trim() ? undefined : 'Save a default Slurm account in the workspace or connection settings.',
        },
      ]

      checks.push(
        await execCheck(connectionId, {
          id: 'analysis-root-write',
          title: 'Run root is writable',
          severity: 'error',
          command: `[ -d ${shellQuote(targetFsPath)} ] && test -w ${shellQuote(targetFsPath)} || { parent=$(dirname ${shellQuote(targetFsPath)}); test -d "$parent" && test -w "$parent"; }`,
          passDetail: targetFsPath,
          failDetail: `Cannot write to ${targetFsPath}.`,
          suggestion: 'Create the folder or pick a writable scratch/project directory.',
        }),
        await execCheck(connectionId, {
          id: 'sbatch',
          title: 'Slurm submit command',
          severity: 'error',
          command: 'command -v sbatch >/dev/null 2>&1',
          passDetail: '`sbatch` is available.',
          failDetail: '`sbatch` is not available in this shell.',
          suggestion: 'Load the cluster Slurm environment or verify this is a Slurm login node.',
        }),
        await execCheck(connectionId, {
          id: 'squeue',
          title: 'Live queue access',
          severity: 'warning',
          command: 'command -v squeue >/dev/null 2>&1 && squeue -h -u "$USER" >/dev/null 2>&1',
          passDetail: '`squeue` works for this account.',
          failDetail: 'Could not run `squeue -u $USER`.',
          suggestion: 'Queue monitoring may be incomplete until `squeue` is available.',
        }),
        await execCheck(connectionId, {
          id: 'sacct',
          title: 'Accounting access',
          severity: 'warning',
          command: 'command -v sacct >/dev/null 2>&1 && sacct -n -X -u "$USER" -S now-1days -o JobID >/dev/null 2>&1',
          passDetail: '`sacct` works for this account.',
          failDetail: 'Could not run `sacct` history lookup.',
          suggestion: 'Past-job diagnostics may be limited until `sacct` is available.',
        }),
        await execCheck(connectionId, {
          id: 'module-system',
          title: 'Environment modules',
          severity: 'warning',
          command: 'command -v module >/dev/null 2>&1 || type module >/dev/null 2>&1',
          passDetail: 'Module environment detected.',
          failDetail: 'No `module` command found in the login shell.',
          suggestion: 'Tool module loading may fail unless the cluster environment initializes modules for non-interactive shells.',
        }),
        await execCheck(connectionId, {
          id: 'disk-space',
          title: 'Free space check',
          severity: 'warning',
          command: `df -Pk ${shellQuote(targetFsPath)} | awk 'NR==2 { exit ($4 >= 10485760 ? 0 : 1) }'`,
          passDetail: `At least 10 GB free under ${targetFsPath}.`,
          failDetail: `Less than 10 GB free under ${targetFsPath}.`,
          suggestion: 'Choose a higher-capacity scratch/project folder before launching larger runs.',
        }),
      )

      if (toolsRoot.trim()) {
        checks.push(await execCheck(connectionId, {
          id: 'tools-root',
          title: 'Tools root path',
          severity: 'warning',
          command: `test -d ${shellQuote(resolvedToolsRoot)}`,
          passDetail: resolvedToolsRoot,
          failDetail: `Tools root not found: ${resolvedToolsRoot}`,
          suggestion: 'Update the workspace/settings tools root if shared tool installs live elsewhere.',
        }))
      }
      if (annovarScriptsPath.trim()) {
        checks.push(await execCheck(connectionId, {
          id: 'annovar-scripts',
          title: 'ANNOVAR scripts path',
          severity: 'warning',
          command: `test -d ${shellQuote(resolvedAnnovarScriptsPath)} || test -f ${shellQuote(`${resolvedAnnovarScriptsPath.replace(/\/+$/, '')}/table_annovar.pl`)}`,
          passDetail: resolvedAnnovarScriptsPath,
          failDetail: `ANNOVAR scripts path not found: ${resolvedAnnovarScriptsPath}`,
          suggestion: 'Run the ANNOVAR setup wizard or correct the path in the workspace.',
        }))
      }
      if (annovarDbPath.trim()) {
        checks.push(await execCheck(connectionId, {
          id: 'annovar-db',
          title: 'ANNOVAR database path',
          severity: 'warning',
          command: `test -d ${shellQuote(resolvedAnnovarDbPath)}`,
          passDetail: resolvedAnnovarDbPath,
          failDetail: `ANNOVAR humandb path not found: ${resolvedAnnovarDbPath}`,
          suggestion: 'Install the needed ANNOVAR databases or point BioFlow at the correct humandb folder.',
        }))
      }
      if (vepPath.trim()) {
        checks.push(await execCheck(connectionId, {
          id: 'vep-path',
          title: 'VEP executable',
          severity: 'warning',
          command: `test -x ${shellQuote(resolvedVepPath)} || command -v ${shellQuote(resolvedVepPath)} >/dev/null 2>&1`,
          passDetail: resolvedVepPath,
          failDetail: `VEP executable not found: ${resolvedVepPath}`,
          suggestion: 'Update the VEP executable path or load the cluster module that provides it.',
        }))
      }
      if (vepCachePath.trim()) {
        checks.push(await execCheck(connectionId, {
          id: 'vep-cache',
          title: 'VEP cache path',
          severity: 'warning',
          command: `test -d ${shellQuote(resolvedVepCachePath)}`,
          passDetail: resolvedVepCachePath,
          failDetail: `VEP cache path not found: ${resolvedVepCachePath}`,
          suggestion: 'Point BioFlow at the correct cache location before running annotation nodes.',
        }))
      }

      const report: ClusterDoctorReport = {
        connectionId,
        workspaceId: workspace?.id,
        createdAt: Date.now(),
        checks,
      }
      set((state) => ({
        reports: { ...state.reports, [cacheKey]: report },
        loadingByConnection: { ...state.loadingByConnection, [cacheKey]: false },
      }))
      return report
    } catch (error: any) {
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
      const cacheKey = doctorReportKey(connectionId, workspaceId)
      const report: ClusterDoctorReport = {
        connectionId,
        workspaceId: workspaceId ?? undefined,
        createdAt: Date.now(),
        checks: [{
          id: 'doctor-failed',
          title: 'Cluster doctor could not complete',
          severity: 'error',
          status: 'error',
          detail: error?.message ?? String(error),
          suggestion: 'Reconnect and retry. If SSH commands are failing, check the connection log first.',
        }],
      }
      set((state) => ({
        reports: { ...state.reports, [cacheKey]: report },
        loadingByConnection: { ...state.loadingByConnection, [cacheKey]: false },
      }))
      return report
    }
  },
}))

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function expandHome(path: string | undefined, home: string): string {
  const trimmed = path?.trim()
  if (!trimmed) return ''
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return `${home}/${trimmed.slice(2)}`
  return trimmed
}
