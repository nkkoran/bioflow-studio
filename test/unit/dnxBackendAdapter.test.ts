import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getAppPath: () => '/tmp',
  },
  safeStorage: {
    decryptString: () => '',
  },
}))

let stripSlurmPreamble: typeof import('../../electron/pipeline/DnxBackendAdapter').stripSlurmPreamble

beforeAll(async () => {
  ;({ stripSlurmPreamble } = await import('../../electron/pipeline/DnxBackendAdapter'))
})

describe('DnxBackendAdapter helpers', () => {
  it('removes the slurm header before SAK submission', () => {
    const script = `#!/bin/bash
#SBATCH --job-name=bioflow-node
#SBATCH --time=01:00:00
module load plink/2.00a3
plink2 --pfile cohort --out result`

    expect(stripSlurmPreamble(script)).toBe(`module load plink/2.00a3
plink2 --pfile cohort --out result`)
  })
})
