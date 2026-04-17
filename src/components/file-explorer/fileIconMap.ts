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
  pgen: { icon: Dna, color: 'text-blue-400' },
  pvar: { icon: Dna, color: 'text-blue-400' },
  psam: { icon: Dna, color: 'text-blue-400' },
  // PLINK1 filesets
  bed: { icon: Dna, color: 'text-cyan-400' },
  bim: { icon: Dna, color: 'text-cyan-400' },
  fam: { icon: Dna, color: 'text-cyan-400' },
  // Data files
  bgen: { icon: Database, color: 'text-purple-400' },
  vcf: { icon: Dna, color: 'text-green-400' },
  'vcf.gz': { icon: Dna, color: 'text-green-400' },
  // Tabular
  tsv: { icon: Table2, color: 'text-emerald-400' },
  csv: { icon: Table2, color: 'text-emerald-400' },
  pheno: { icon: Table2, color: 'text-emerald-400' },
  txt: { icon: FileText, color: 'text-text-secondary' },
  // Scripts
  R: { icon: FileCode, color: 'text-blue-300' },
  r: { icon: FileCode, color: 'text-blue-300' },
  py: { icon: FileCode, color: 'text-yellow-400' },
  sh: { icon: Terminal, color: 'text-green-300' },
  bash: { icon: Terminal, color: 'text-green-300' },
  // Config
  json: { icon: FileJson, color: 'text-yellow-300' },
  yaml: { icon: FileJson, color: 'text-yellow-300' },
  yml: { icon: FileJson, color: 'text-yellow-300' },
  // Archives
  gz: { icon: Archive, color: 'text-text-muted' },
  tar: { icon: Archive, color: 'text-text-muted' },
  zip: { icon: Archive, color: 'text-text-muted' },
  // Images
  png: { icon: Image, color: 'text-pink-400' },
  jpg: { icon: Image, color: 'text-pink-400' },
  pdf: { icon: FileText, color: 'text-red-400' },
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
