import { z } from 'zod'

export const connectionConfigSchema = z.object({
  name: z.string().trim().min(1, 'Connection name is required'),
  host: z.string().trim().min(1, 'Host is required'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1, 'Username is required'),
  authMethod: z.enum(['key', 'password', 'agent']),
  transport: z.enum(['ssh2', 'openssh-controlpersist']).optional(),
  privateKeyPath: z.string().trim().optional(),
  passphrase: z.string().optional(),
  password: z.string().optional(),
  alias: z.string().trim().optional(),
  writeConfig: z.boolean().optional(),
  controlPersistHours: z.number().min(1).max(72).optional(),
  serverAliveIntervalSeconds: z.number().min(15).max(3600).optional(),
  defaultDirectory: z.string().trim().optional(),
}).refine(
  (data) => {
    if (data.authMethod === 'key') return !!data.privateKeyPath
    if (data.authMethod === 'password') return !!data.password
    return true
  },
  {
    message: 'Key-based auth requires a private key path; password auth requires a password',
  }
  )

export type ValidatedConnectionConfig = z.infer<typeof connectionConfigSchema>
