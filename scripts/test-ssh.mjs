#!/usr/bin/env node
/**
 * Standalone SSH connection test — run with:
 *   node scripts/test-ssh.mjs <host> <username> <keypath>
 *
 * Example:
 *   node scripts/test-ssh.mjs rorqual.alliancecan.ca nkkoran ~/.ssh/id_ed25519
 *
 * This helps isolate whether SSH auth issues are in the ssh2 library
 * or in BioFlow's Electron integration.
 */

import { Client } from 'ssh2'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const [,, host, username, keyPath] = process.argv

if (!host || !username) {
  console.log('Usage: node scripts/test-ssh.mjs <host> <username> [keypath]')
  console.log('Example: node scripts/test-ssh.mjs rorqual.alliancecan.ca nkkoran ~/.ssh/id_ed25519')
  process.exit(1)
}

function expandPath(p) {
  if (p?.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2))
  }
  return p ? resolve(p) : null
}

const expandedKey = expandPath(keyPath)
const conn = new Client()

const config = {
  host,
  port: 22,
  username,
  readyTimeout: 30_000,
  tryKeyboard: true,
  debug: (msg) => {
    // Only show auth-related debug lines to reduce noise
    if (msg.includes('Auth') || msg.includes('auth') || msg.includes('Handshake') ||
        msg.includes('handshake') || msg.includes('offer') || msg.includes('KEX') ||
        msg.includes('error') || msg.includes('Error')) {
      console.log(`[debug] ${msg}`)
    }
  },
  algorithms: {
    kex: [
      'curve25519-sha256',
      'curve25519-sha256@libssh.org',
      'ecdh-sha2-nistp256',
      'ecdh-sha2-nistp384',
      'ecdh-sha2-nistp521',
      'diffie-hellman-group-exchange-sha256',
      'diffie-hellman-group14-sha256',
      'diffie-hellman-group16-sha512',
      'diffie-hellman-group18-sha512',
      'diffie-hellman-group14-sha1',
    ],
    serverHostKey: [
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
    ],
    cipher: [
      'aes128-gcm',
      'aes128-gcm@openssh.com',
      'aes256-gcm',
      'aes256-gcm@openssh.com',
      'aes128-ctr',
      'aes192-ctr',
      'aes256-ctr',
    ],
    hmac: [
      'hmac-sha2-256-etm@openssh.com',
      'hmac-sha2-512-etm@openssh.com',
      'hmac-sha2-256',
      'hmac-sha2-512',
      'hmac-sha1',
    ],
  },
}

// Key auth
if (expandedKey && existsSync(expandedKey)) {
  console.log(`Loading key from: ${expandedKey}`)
  const keyData = readFileSync(expandedKey)
  console.log(`Key size: ${keyData.length} bytes`)
  console.log(`Key starts with: ${keyData.toString('utf-8').split('\n')[0]}`)
  config.privateKey = keyData
} else if (keyPath) {
  console.error(`Key file not found: ${expandedKey}`)
  process.exit(1)
}

// Also try agent
if (process.env.SSH_AUTH_SOCK) {
  console.log(`SSH agent detected: ${process.env.SSH_AUTH_SOCK}`)
  config.agent = process.env.SSH_AUTH_SOCK
} else {
  console.log('No SSH agent detected (SSH_AUTH_SOCK not set)')
}

console.log(`\nConnecting to ${host}:22 as ${username}...`)
console.log(`Auth methods: ${expandedKey ? 'publickey' : ''}${process.env.SSH_AUTH_SOCK ? ' agent' : ''} keyboard-interactive\n`)

conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
  console.log(`[keyboard-interactive] name="${name}" instructions="${instructions}"`)
  console.log(`[keyboard-interactive] prompts:`, prompts.map(p => p.prompt))
  const rl = readline.createInterface({ input, output })
  void (async () => {
    try {
      const responses = []
      for (const prompt of prompts) {
        if (instructions) console.log(instructions)
        const response = await rl.question(prompt.prompt || 'Authentication response: ')
        responses.push(response)
      }
      finish(responses)
    } finally {
      rl.close()
    }
  })().catch((err) => {
    console.error('[keyboard-interactive] prompt failed:', err)
    finish(prompts.map(() => ''))
  })
})

conn.on('handshake', (negotiated) => {
  console.log('\n[handshake] Negotiated:', JSON.stringify(negotiated, null, 2))
})

conn.on('ready', () => {
  console.log('\n✅ SSH connection successful!')

  conn.exec('echo $HOME && hostname && whoami', (err, stream) => {
    if (err) {
      console.error('exec error:', err)
      conn.end()
      return
    }
    let output = ''
    stream.on('data', (data) => { output += data.toString() })
    stream.on('close', () => {
      console.log('Remote info:', output.trim())
      conn.end()
      process.exit(0)
    })
  })
})

conn.on('error', (err) => {
  console.error(`\n❌ SSH connection failed: ${err.message}`)
  console.error(`Error level: ${err.level || 'unknown'}`)
  process.exit(1)
})

conn.connect(config)

// Timeout
setTimeout(() => {
  console.error('\n❌ Connection timed out after 30s')
  conn.end()
  process.exit(1)
}, 35_000)
