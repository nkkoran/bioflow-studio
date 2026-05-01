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
      { key: '1', path: '/data/plink/chr1/geno.pgen' },
      { key: '2', path: '/data/plink/chr2/geno.pgen' },
    ])
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
