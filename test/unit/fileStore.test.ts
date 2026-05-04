import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectionStore } from '@/stores/connectionStore'
import { useFileStore } from '@/stores/fileStore'

describe('fileStore remote listing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    ;(globalThis as any).window = {
      api: {
        ssh: {
          exec: vi.fn().mockResolvedValue({ stdout: '/home/nk', stderr: '', exitCode: 0 }),
        },
        sftp: {
          ls: vi.fn().mockResolvedValue([]),
        },
        local: {
          ls: vi.fn().mockResolvedValue([]),
        },
        store: {
          get: vi.fn(),
          set: vi.fn(),
        },
      },
    }
    useConnectionStore.setState({
      activeConnectionId: 'rorqual',
      connections: {
        rorqual: {
          config: {
            name: 'Rorqual',
            host: 'rorqual.alliancecan.ca',
            port: 22,
            username: 'nk',
            authMethod: 'key',
            transport: 'openssh-controlpersist',
            defaultDirectory: '~',
          },
          status: 'connected',
          connectedAt: Date.now(),
          isLocal: false,
        },
      },
      loginPolicy: {},
    })
    useFileStore.setState({
      cwd: '~',
      cwdConnectionId: null,
      entries: [],
      loading: false,
      error: null,
      bookmarks: [],
      sortField: 'name',
      sortDirection: 'asc',
      selectedPaths: [],
    })
  })

  it('expands remote home before initial SFTP listing', async () => {
    await useFileStore.getState().navigate('~', { connectionId: 'rorqual' })

    expect(window.api.ssh.exec).toHaveBeenCalledWith('rorqual', 'printf %s "$HOME"')
    expect(window.api.sftp.ls).toHaveBeenCalledWith('rorqual', '/home/nk', { force: undefined })
    expect(useFileStore.getState().error).toBeNull()
  })

  it('retries a failed listing with force refresh and expanded home path', async () => {
    vi.mocked(window.api.sftp.ls)
      .mockRejectedValueOnce(new Error('remote directory failed to open'))
      .mockResolvedValueOnce([])

    await useFileStore.getState().navigate('~/project', { connectionId: 'rorqual' })
    expect(useFileStore.getState().error).toBe('remote directory failed to open')

    await useFileStore.getState().refresh()

    expect(window.api.sftp.ls).toHaveBeenLastCalledWith('rorqual', '/home/nk/project', { force: true })
    expect(useFileStore.getState().error).toBeNull()
  })
})
