import { describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import {
  bioflowControlPath,
  bioflowOpenSshAlias,
  buildExpectScript,
  buildOpenSshLsCommand,
  buildOpenSshBaseArgs,
  buildOpenSshHostBlock,
  buildOpenSshMasterCheckArgs,
  buildOpenSshTerminalArgs,
  buildOpenSshTerminalExpectScript,
  buildOpenSshTerminalPtyInvocation,
  buildPtyInvocation,
  extractOpenSshInteractivePrompt,
  openSshShellQuote,
  parseOpenSshFindOutput,
  parseOpenSshStatOutput,
  sanitizeOpenSshAlias,
  shouldAutoRespondOpenSshPrompt,
} from '../../electron/ssh/OpenSshTransport'
import type { ConnectionConfig } from '@/types/ssh'

const baseConfig: ConnectionConfig = {
  name: 'Rorqual Lab',
  host: 'rorqual.alliancecan.ca',
  port: 22,
  username: 'nk',
  authMethod: 'key',
  privateKeyPath: '~/.ssh/bioflow_rorqual_nk',
  transport: 'openssh-controlpersist',
  controlPersistHours: 12,
  serverAliveIntervalSeconds: 45,
}

describe('OpenSSH ControlPersist transport helpers', () => {
  it('builds a deterministic managed host block with ControlPersist settings', () => {
    const block = buildOpenSshHostBlock(baseConfig)

    expect(block).toContain('Host bioflow-nk-rorqual.alliancecan.ca-22')
    expect(block).toContain('HostName rorqual.alliancecan.ca')
    expect(block).toContain('ControlMaster auto')
    expect(block).toContain('ControlPath ~/.ssh/controlmasters/%C')
    expect(block).toContain('ControlPersist 12h')
    expect(block).toContain('ServerAliveInterval 45')
    expect(block).toContain('PreferredAuthentications publickey,keyboard-interactive,password')
  })

  it('sanitizes aliases and shell-quotes unsafe remote paths', () => {
    expect(sanitizeOpenSshAlias(' Rorqual Lab! ')).toBe('Rorqual-Lab')
    expect(bioflowOpenSshAlias(baseConfig)).toBe('bioflow-nk-rorqual.alliancecan.ca-22')
    expect(openSshShellQuote('/project/nk/results.tsv')).toBe('/project/nk/results.tsv')
    expect(openSshShellQuote("/project/nk/weird file's.tsv")).toBe("'/project/nk/weird file'\"'\"'s.tsv'")
  })

  it('lists symlinked project directories through find -H', () => {
    const command = buildOpenSshLsCommand('/project/rrg-jamiece')

    expect(command).toContain('find -H "$dir"')
    expect(command).toContain('[ -d "$dir" ] || exit 2')
  })

  it('builds config-independent ssh args for BioFlow app operations', () => {
    const controlPath = bioflowControlPath(baseConfig)
    const args = buildOpenSshBaseArgs(baseConfig, controlPath)

    expect(args.slice(0, 4)).toEqual(['-F', '/dev/null', '-S', controlPath])
    expect(args).toContain('-l')
    expect(args).toContain('nk')
    expect(args).toContain('-p')
    expect(args).toContain('22')
    expect(args).toContain('-i')
    expect(args.some((arg) => arg.includes('bioflow_rorqual_nk'))).toBe(true)
    expect(args).toContain('PreferredAuthentications=publickey,keyboard-interactive,password')
    expect(args.join(' ')).not.toContain('calculquebec')
  })

  it('can build non-interactive ssh args for background operations', () => {
    const controlPath = bioflowControlPath(baseConfig)
    const args = buildOpenSshBaseArgs(baseConfig, controlPath, { batchMode: true })

    expect(args).toContain('NumberOfPasswordPrompts=0')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('PasswordAuthentication=no')
    expect(args).toContain('KbdInteractiveAuthentication=no')
    expect(args).not.toContain('NumberOfPasswordPrompts=3')
  })

  it('checks ControlPersist masters without allowing interactive prompts', () => {
    const controlPath = bioflowControlPath(baseConfig)
    const args = buildOpenSshMasterCheckArgs(baseConfig, controlPath)

    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('KbdInteractiveAuthentication=no')
    expect(args).toContain('NumberOfPasswordPrompts=0')
    expect(args.slice(-3)).toEqual(['-O', 'check', baseConfig.host])
  })

  it('builds terminal args that target the BioFlow control socket', () => {
    const controlPath = `${bioflowControlPath(baseConfig)} with spaces`
    const args = buildOpenSshTerminalArgs({
      connectionId: 'conn-1',
      config: baseConfig,
      alias: bioflowOpenSshAlias(baseConfig),
      controlPath,
    })

    expect(args.slice(0, 4)).toEqual(['-F', '/dev/null', '-S', controlPath])
    expect(args).toContain('-tt')
    expect(args).toContain('-l')
    expect(args).toContain('nk')
    expect(args).toContain('-p')
    expect(args).toContain('22')
    expect(args[args.length - 1]).toBe('rorqual.alliancecan.ca')
  })

  it('wraps master startup in an expect-managed pty when expect is available', async () => {
    const invocation = buildPtyInvocation('ssh', ['-F', '/dev/null', '-MNf', 'rorqual.alliancecan.ca'], 'http://127.0.0.1:9/askpass')
    if (!invocation) return

    expect(invocation.command).toContain('expect')
    expect(invocation.args.join(' ')).toContain('ssh')
    expect(invocation.args.join(' ')).toContain('rorqual.alliancecan.ca')
    expect(invocation.env?.BIOFLOW_PROMPT_URL).toBe('http://127.0.0.1:9/askpass')
    await invocation.cleanup?.()
  })

  it('wraps OpenSSH terminal sessions in an expect-managed interactive pty when available', async () => {
    const invocation = buildOpenSshTerminalPtyInvocation('ssh', ['-F', '/dev/null', '-tt', 'rorqual.alliancecan.ca'], 101, 33)
    if (!invocation) return

    expect(invocation.command).toContain('expect')
    expect(invocation.args.join(' ')).toContain('-tt')
    expect(invocation.args[invocation.args.length - 1]).toBe('rorqual.alliancecan.ca')
    expect(invocation.env?.TERM).toBeTruthy()
    expect(invocation.env?.BIOFLOW_TERM_SIZE_FILE).toBeTruthy()
    invocation.resize?.(88, 24)
    await invocation.cleanup?.()
  })

  it('builds an expect script that routes interactive prompts to BioFlow', () => {
    const script = buildExpectScript()

    expect(script).toContain('spawn {*}$argv')
    expect(script).toContain('Passcode or option')
    expect(script).toContain('BIOFLOW_PROMPT_URL')
  })

  it('builds an expect script that bridges terminal input through interact', () => {
    const script = buildOpenSshTerminalExpectScript()

    expect(script).toContain('spawn {*}$argv')
    expect(script).toContain('interact')
    expect(script).toContain('BIOFLOW_TERM_SIZE_FILE')
    expect(script).toContain('bioflow_schedule_size')
    expect(script).toContain('log_user 0')
    expect(script).not.toContain('SIGUSR1')
  })

  it('passes Node pipe input through the expect-managed terminal pty', async () => {
    const invocation = buildOpenSshTerminalPtyInvocation('sh', [], 80, 24)
    if (!invocation) return

    let output = ''
    const child = spawn(invocation.command, invocation.args, { env: invocation.env ?? process.env })
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill()
          reject(new Error('Timed out waiting for expect-managed terminal pty'))
        }, 3000)
        child.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
        child.on('close', (code) => {
          clearTimeout(timeout)
          if (code === 0) resolve()
          else reject(new Error(`Terminal pty exited with ${code}: ${output}`))
        })
        setTimeout(() => {
          child.stdin.write('echo __BIOFLOW_EXPECT_TERMINAL_OK__\nexit\n')
        }, 50)
      })
    } finally {
      await invocation.cleanup?.()
    }

    expect(output).toContain('__BIOFLOW_EXPECT_TERMINAL_OK__')
    expect(output).toContain('echo __BIOFLOW_EXPECT_TERMINAL_OK__')
    expect(output).not.toContain('spawn sh')
  })

  it('extracts Duo keyboard-interactive prompts from pty transcripts', () => {
    const prompt = extractOpenSshInteractivePrompt([
      'Multifactor authentication is now mandatory\n',
      'Duo two-factor login for nk\n\n',
      'Enter a passcode or select one of the following options:\n\n',
      '1. Duo Push to Phone\n\n',
      'Passcode or option (1-1): ',
    ].join(''))

    expect(prompt).toContain('Duo two-factor login')
    expect(prompt).toContain('Passcode or option (1-1):')
  })

  it('parses GNU find null-separated rows into remote file entries', () => {
    const buffer = Buffer.from([
      'b.txt', '/work/b.txt', 'f', 'f', '20', '1000.5', '-rw-r--r--',
      'adir', '/work/adir', 'd', 'd', '4096', '1001', 'drwxr-xr-x',
      '',
    ].join('\0'))

    const entries = parseOpenSshFindOutput(buffer)

    expect(entries.map((entry) => entry.name)).toEqual(['adir', 'b.txt'])
    expect(entries[0].isDirectory).toBe(true)
    expect(entries[1].extension).toBe('txt')
    expect(entries[1].modified).toBe(1000500)
  })

  it('treats symlinks to directories as directories in OpenSSH listings', () => {
    const buffer = Buffer.from([
      'project-a', '/home/nk/projects/project-a', 'l', 'd', '4096', '1002', 'lrwxr-xr-x',
      '',
    ].join('\0'))

    expect(parseOpenSshFindOutput(buffer)[0]).toMatchObject({
      name: 'project-a',
      isDirectory: true,
      extension: '',
    })
  })

  it('parses stat output and detects directories from mode bits', () => {
    expect(parseOpenSshStatOutput('4096\t1700000000\t41ed\tdrwxr-xr-x\n')).toEqual({
      size: 4096,
      modified: 1700000000 * 1000,
      isDirectory: true,
      permissions: 'drwxr-xr-x',
    })
  })

  it('auto-responds only once to ordinary password prompts and never to MFA prompts', () => {
    const config: ConnectionConfig = {
      ...baseConfig,
      authMethod: 'password',
      password: 'secret',
      rememberPassword: true,
    }
    const state = { passwordAutoResponded: false }

    expect(shouldAutoRespondOpenSshPrompt(config, "nk@rorqual's password:", state)).toBe(true)
    expect(shouldAutoRespondOpenSshPrompt(config, "nk@rorqual's password:", state)).toBe(false)
    expect(shouldAutoRespondOpenSshPrompt({ ...config, password: 'secret' }, 'Verification code:', { passwordAutoResponded: false })).toBe(false)
  })
})
