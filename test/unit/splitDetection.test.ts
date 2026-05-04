import { describe, expect, it } from 'vitest'
import { detectSplitInFolder } from '@/lib/splitDetection'
import type { RemoteFileEntry } from '@/types/files'

describe('splitDetection', () => {
  it('detects a folder split and keeps the original folder path', async () => {
    const entries: RemoteFileEntry[] = [
      {
        name: 'chr1.pgen',
        path: '/data/plink/chr1.pgen',
        isDirectory: false,
        size: 1,
        modified: 1,
        permissions: '-rw-r--r--',
        extension: 'pgen',
      },
      {
        name: 'chr2.pgen',
        path: '/data/plink/chr2.pgen',
        isDirectory: false,
        size: 1,
        modified: 1,
        permissions: '-rw-r--r--',
        extension: 'pgen',
      },
      {
        name: 'README.txt',
        path: '/data/plink/README.txt',
        isDirectory: false,
        size: 1,
        modified: 1,
        permissions: '-rw-r--r--',
        extension: 'txt',
      },
    ]

    const detected = await detectSplitInFolder({
      listFolder: async (folder) => {
        expect(folder).toBe('/data/plink')
        return entries
      },
      folder: '/data/plink',
      mode: 'auto',
      axis: 'file',
      fileType: 'pgen',
      seedPath: '/data/plink',
    })

    expect(detected.folderPath).toBe('/data/plink')
    expect(detected.pattern).toMatchObject({
      kind: 'glob',
      template: '/data/plink/chr*.pgen',
      capture: 'key',
    })
    expect(detected.items.map((item) => item.key)).toEqual(['1', '2'])
  })

  it('detects one item folder per axis value without falling back to the parent folder', async () => {
    const rootEntries: RemoteFileEntry[] = [
      entry('chr1', '/data/plink/chr1', true),
      entry('chr2', '/data/plink/chr2', true),
    ]
    const nestedEntries: Record<string, RemoteFileEntry[]> = {
      '/data/plink': rootEntries,
      '/data/plink/chr1': [entry('geno.pgen', '/data/plink/chr1/geno.pgen', false)],
      '/data/plink/chr2': [entry('geno.pgen', '/data/plink/chr2/geno.pgen', false)],
    }

    const detected = await detectSplitInFolder({
      listFolder: async (folder) => nestedEntries[folder] ?? [],
      folder: '/data/plink',
      mode: 'auto',
      axis: 'chrom',
      fileType: 'pgen',
      seedPath: '/data/plink',
    })

    expect(detected.folderPath).toBe('/data/plink')
    expect(detected.pattern).toEqual({
      kind: 'crossFolder',
      parentDir: '/data/plink',
      childGlob: 'chr*',
      file: 'geno.pgen',
    })
    expect(detected.items).toEqual([
      { key: '1', rawKey: '1', path: '/data/plink/chr1/geno.pgen' },
      { key: '2', rawKey: '2', path: '/data/plink/chr2/geno.pgen' },
    ])
  })

  it('prefers primary PGEN files over sidecars in mixed UKB-style folders', async () => {
    const entries: RemoteFileEntry[] = []
    for (let chrom = 1; chrom <= 23; chrom++) {
      entries.push(
        entry(`ukb22828_c${chrom}_b0_v3.pgen`, `/ukb/genotype/ukb22828_c${chrom}_b0_v3.pgen`, false),
        entry(`ukb22828_c${chrom}_b0_v3.pvar`, `/ukb/genotype/ukb22828_c${chrom}_b0_v3.pvar`, false),
        entry(`ukb22828_c${chrom}_b0_v3.psam`, `/ukb/genotype/ukb22828_c${chrom}_b0_v3.psam`, false),
      )
    }

    const detected = await detectSplitInFolder({
      listFolder: async (folder) => {
        expect(folder).toBe('/ukb/genotype')
        return entries
      },
      folder: '/ukb/genotype',
      mode: 'auto',
      axis: 'chromosome',
      fileType: 'any',
      seedPath: '/ukb/genotype',
    })

    expect(detected.items).toHaveLength(23)
    expect(detected.items.map((item) => item.key)).toEqual(Array.from({ length: 23 }, (_, index) => String(index + 1)))
    expect(detected.items.every((item) => item.path.endsWith('.pgen'))).toBe(true)
    expect(detected.summary).toContain('chromosome 1-23')
  })

  it('expands the full folder split when nested filenames vary and some child listings fail once', async () => {
    const rootEntries = Array.from({ length: 23 }, (_, index) => {
      const chrom = index + 1
      return entry(`chr${chrom}`, `/ukb/nested/chr${chrom}`, true)
    })
    const flakyFolders = new Set(['/ukb/nested/chr15', '/ukb/nested/chr23'])
    const attempts = new Map<string, number>()

    const detected = await detectSplitInFolder({
      listFolder: async (folder) => {
        if (folder === '/ukb/nested') return rootEntries
        const attempt = (attempts.get(folder) ?? 0) + 1
        attempts.set(folder, attempt)
        if (flakyFolders.has(folder) && attempt === 1) {
          throw new Error(`temporary failure for ${folder}`)
        }
        const chrom = folder.match(/chr(\d+)$/)?.[1]
        return chrom
          ? [entry(`ukb_chr${chrom}.pgen`, `${folder}/ukb_chr${chrom}.pgen`, false)]
          : []
      },
      folder: '/ukb/nested',
      mode: 'auto',
      axis: 'chromosome',
      fileType: 'pgen',
      seedPath: '/ukb/nested',
    })

    expect(detected.pattern).toEqual({ kind: 'manual' })
    expect(detected.items).toHaveLength(23)
    expect(detected.items.map((item) => item.key)).toEqual(Array.from({ length: 23 }, (_, index) => String(index + 1)))
    expect(detected.items[14]?.path).toBe('/ukb/nested/chr15/ukb_chr15.pgen')
    expect(detected.items[22]?.path).toBe('/ukb/nested/chr23/ukb_chr23.pgen')
  })
})

function entry(name: string, path: string, isDirectory: boolean): RemoteFileEntry {
  return {
    name,
    path,
    isDirectory,
    size: 1,
    modified: 1,
    permissions: isDirectory ? 'drwxr-xr-x' : '-rw-r--r--',
    extension: isDirectory ? '' : name.split('.').pop() ?? '',
  }
}
