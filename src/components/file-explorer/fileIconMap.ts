import {
  Folder,
  FolderOpen,
  File,
  FileText,
  FileCode,
  Table2,
  Terminal,
  Archive,
  Image,
  Database,
  FileJson,
  Dna,
  type LucideIcon,
} from 'lucide-react'

export interface FileIconDef {
  icon: LucideIcon
  color: string
}

const extensionMap: Record<string, FileIconDef> = {
  // PLINK2 filesets
  pgen: { icon: Dna, color: 'text-accent' },
  pvar: { icon: Dna, color: 'text-accent' },
  psam: { icon: Dna, color: 'text-accent' },
  // PLINK1 filesets
  bed: { icon: Dna, color: 'text-accent' },
  bim: { icon: Dna, color: 'text-accent' },
  fam: { icon: Dna, color: 'text-accent' },
  // Data files
  bgen: { icon: Database, color: 'text-text-secondary' },
  vcf: { icon: Dna, color: 'text-accent' },
  'vcf.gz': { icon: Dna, color: 'text-accent' },
  // Tabular
  tsv: { icon: Table2, color: 'text-text-secondary' },
  csv: { icon: Table2, color: 'text-text-secondary' },
  pheno: { icon: Table2, color: 'text-text-secondary' },
  txt: { icon: FileText, color: 'text-text-secondary' },
  // Scripts
  R: { icon: FileCode, color: 'text-text-secondary' },
  r: { icon: FileCode, color: 'text-text-secondary' },
  py: { icon: FileCode, color: 'text-text-secondary' },
  sh: { icon: Terminal, color: 'text-text-secondary' },
  bash: { icon: Terminal, color: 'text-text-secondary' },
  // Config
  json: { icon: FileJson, color: 'text-text-secondary' },
  yaml: { icon: FileJson, color: 'text-text-secondary' },
  yml: { icon: FileJson, color: 'text-text-secondary' },
  // Archives
  gz: { icon: Archive, color: 'text-text-muted' },
  tar: { icon: Archive, color: 'text-text-muted' },
  zip: { icon: Archive, color: 'text-text-muted' },
  // Images
  png: { icon: Image, color: 'text-text-secondary' },
  jpg: { icon: Image, color: 'text-text-secondary' },
  pdf: { icon: FileText, color: 'text-text-secondary' },
  // Log files
  log: { icon: FileText, color: 'text-text-muted' },
  out: { icon: FileText, color: 'text-text-muted' },
  err: { icon: FileText, color: 'text-text-muted' },
}

const defaultFileIcon: FileIconDef = { icon: File, color: 'text-text-muted' }

export function getFileIcon(
  extension: string,
  isDirectory: boolean,
  isOpen = false,
): FileIconDef {
  if (isDirectory) {
    return { icon: isOpen ? FolderOpen : Folder, color: 'text-accent' }
  }

  // Try compound extension first (e.g. vcf.gz)
  const dotIdx = extension.indexOf('.')
  if (dotIdx !== -1) {
    const compound = extension.toLowerCase()
    if (compound in extensionMap) return extensionMap[compound]
  }

  const ext = extension.toLowerCase()
  return extensionMap[ext] ?? defaultFileIcon
}
