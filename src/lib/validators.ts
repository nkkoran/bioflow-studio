import { z } from 'zod'

export const connectionConfigSchema = z.object({
  name: z.string().min(1, 'Connection name is required'),
  host: z.string().min(1, 'Host is required'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1, 'Username is required'),
  authMethod: z.enum(['key', 'password', 'agent']),
  privateKeyPath: z.string().optional(),
  passphrase: z.string().optional(),
  password: z.string().optional(),
  defaultDirectory: z.string().optional(),
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
