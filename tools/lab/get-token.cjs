#!/usr/bin/env node
/**
 * Refreshes GENESYS_TOKEN_A1 (or A2) in tools/lab/.env.lab without a human:
 * runs the implicit-grant sign-in through the persistent, logged-in lab
 * profile and captures the access_token from the redirect fragment.
 *
 *   node tools/lab/get-token.cjs [a1|a2] [--client <oauth client id>]
 *
 * Default client: the app's own (VITE_GENESYS_OAUTH_CLIENT_ID from .env.local).
 * Redirect URI: APP_BASE (must be registered on that client).
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')
const app = require('./actors/app.cjs')

const who = process.argv[2] ?? 'a1'
const clientIdx = process.argv.indexOf('--client')
const ENV_LAB = path.join(__dirname, '.env.lab')
const ENV_LOCAL = path.join(__dirname, '..', '..', '.env.local')
const readEnv = (file) =>
  Object.fromEntries(
    fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
  )
const lab = readEnv(ENV_LAB)
const env = process.env.GENESYS_ENV ?? lab.GENESYS_ENV
const clientId = clientIdx >= 0 ? process.argv[clientIdx + 1] : readEnv(ENV_LOCAL).VITE_GENESYS_OAUTH_CLIENT_ID
const redirectUri = process.env.APP_BASE ?? 'https://localhost:3000/telecom/agent-app/'
const key = `GENESYS_TOKEN_${who.toUpperCase()}`

const main = async () => {
  const ctx = await chromium.launchPersistentContext(app.profileDir(who), {
    headless: false,
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors']
  })
  const page = await ctx.newPage()
  let token = null
  const grab = (url) => {
    const m = /[#&]access_token=([^&]+)/.exec(url)
    if (m != null && token == null) token = decodeURIComponent(m[1])
  }
  page.on('framenavigated', (f) => grab(f.url()))
  const authorize =
    `https://login.${env}/oauth/authorize?response_type=token&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=lab-token`
  await page.goto(authorize, { waitUntil: 'domcontentloaded' }).catch(() => {})
  const deadline = Date.now() + 60000
  while (token == null && Date.now() < deadline) {
    grab(page.url())
    await new Promise((r) => setTimeout(r, 250))
  }
  await ctx.close()
  if (token == null) throw new Error(`no access_token in redirect within 60 s (session expired? profile needs 'lab app login ${who}')`)

  // Verify and identify.
  const res = await fetch(`https://api.${env}/api/v2/users/me`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`token rejected: ${res.status} ${await res.text()}`)
  const me = await res.json()

  // Write back.
  const lines = fs.readFileSync(ENV_LAB, 'utf8').split('\n')
  const i = lines.findIndex((l) => l.startsWith(`${key}=`))
  if (i >= 0) lines[i] = `${key}=${token}`
  else lines.push(`${key}=${token}`)
  fs.writeFileSync(ENV_LAB, lines.join('\n'))
  console.log(JSON.stringify({ updated: key, user: me.name, id: me.id, tokenLength: token.length }))
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
