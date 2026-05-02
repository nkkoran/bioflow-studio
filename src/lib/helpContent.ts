export interface HelpEntry {
  title: string
  body: string
  example?: string
}

export const HELP_CONTENT: Record<string, HelpEntry> = {
  'settings.general': {
    title: 'General settings',
    body: 'Defaults used when BioFlow prepares Slurm jobs and saves work in the background.',
    example: 'Set a default partition here when most jobs should land on the same cluster queue.',
  },
  'settings.paths': {
    title: 'Run paths',
    body: 'Folder names BioFlow creates inside each run directory for scripts, outputs, logs, and uploads.',
    example: 'runs/{pipelineSlug}-{timestamp} keeps every run separate and easy to inspect.',
  },
  'settings.tools': {
    title: 'Tool locations',
    body: 'Shared installation paths for tools or databases that are not provided by a cluster module.',
  },
  'settings.dnx': {
    title: 'DNAnexus RAP',
    body: 'Developer-only RAP integration for DNAnexus project browsing and UK Biobank extraction jobs.',
  },
  'settings.advanced': {
    title: 'Advanced execution',
    body: 'Controls for SSH transport, pre-run checks, array dependencies, and experimental builder behavior.',
  },
  'settings.notifications': {
    title: 'Notifications',
    body: 'Desktop notices emitted when long-running jobs finish or fail.',
  },
  'developer.gate': {
    title: 'Developer Options',
    body: 'Unlocks unfinished RAP features for development sessions. The lock resets when the app restarts.',
  },
  'inspector.file': {
    title: 'File node',
    body: 'A source file, output placeholder, or split group that can be connected to pipeline steps.',
  },
  'inspector.tool': {
    title: 'Tool node',
    body: 'A runnable command with typed inputs, outputs, parameters, and Slurm resource settings.',
  },
  'inspector.merge': {
    title: 'Merge files',
    body: 'Combines multiple tabular files or fan-out outputs into one downstream file.',
    example: 'Use outer merge to keep all samples when phenotype and covariate files only partly overlap.',
  },
  'inspector.custom': {
    title: 'Custom node',
    body: 'Saved command templates behave like built-in tools and support inputs, outputs, and parameters.',
  },
  'axis.split': {
    title: 'Axis split',
    body: 'Turns a set of files into one logical input with one axis value per file. Downstream tools run as Slurm arrays when appropriate.',
    example: 'A folder of chr1-22 files becomes axis values named after each filename.',
  },
  'merge.columns': {
    title: 'Column assignment',
    body: 'BioFlow previews shared columns across inputs separately from columns that appear in only some files.',
  },
  'params.row': {
    title: 'Parameter',
    body: 'Parameters become command-line arguments when the node runs. Empty optional values are skipped.',
  },
  'params.customFlags': {
    title: 'Custom flags',
    body: 'Use this for tool options that are not modeled yet. Keep one flag per row so reruns are easy to edit.',
    example: '--maf 0.01',
  },
  'onboarding.welcome': {
    title: 'Welcome',
    body: 'The first-run wizard gathers the minimum folders, account, and connection settings needed to run jobs.',
  },
  'onboarding.paths': {
    title: 'Folders',
    body: 'Pick where generated scripts, outputs, and logs should live on your cluster workspace.',
  },
  'onboarding.slurm': {
    title: 'Slurm account',
    body: 'The Slurm account is passed to sbatch when your cluster requires an account allocation.',
  },
  'onboarding.connection': {
    title: 'SSH connection',
    body: 'Connect to Rorqual or another Slurm cluster before running pipelines.',
  },
  'onboarding.dnx': {
    title: 'DNAnexus auth',
    body: 'Developer-only step for verifying a DNAnexus token and default project.',
  },
}

export function getHelpContent(id: string): HelpEntry {
  return HELP_CONTENT[id] ?? {
    title: 'Help',
    body: 'This setting changes how BioFlow builds, validates, or runs your pipeline.',
  }
}
