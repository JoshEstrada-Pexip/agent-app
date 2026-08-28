import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react-swc'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Dev-only capture sink: the capture module (VITE_CAPTURE_EVENTS) POSTs each
// entry here and it lands as JSONL on disk — fixtures write themselves, no
// browser-side harvesting step. Not part of any production build.
const captureSink = (): Plugin => ({
  name: 'capture-sink',
  configureServer(server) {
    server.middlewares.use('/__capture', (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end()
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const dir = path.resolve(__dirname, 'src/genesys/__fixtures__/live')
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(path.join(dir, 'capture.jsonl'), body + '\n')
        res.statusCode = 204
        res.end()
      })
    })
  }
})

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  const basePath = env.VITE_BASE_PATH || '/telecom/agent-app/'

  return {
    base: basePath,
    plugins: [basicSsl(), react(), captureSink()],
    resolve: {
      alias: {
        'purecloud-platform-client-v2': path.resolve(
          __dirname,
          'node_modules/purecloud-platform-client-v2/src/purecloud-platform-client-v2/index.js'
        ),
        react: path.resolve(__dirname, 'node_modules/react'),
        'react-dom': path.resolve(__dirname, 'node_modules/react-dom')
      }
    },
    server: {
      port: 3000,
      open: true
    },
    build: {
      target: 'ES2022',
      cssTarget: ['chrome105', 'safari16', 'firefox121']
    },
    optimizeDeps: {
      exclude: ['platformClient']
    }
  }
})
