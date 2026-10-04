import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function tunnelOptions(env = process.env) {
  if (!/^tunnel_[0-9a-f]{32}$/.test(env.CONTROL_PLANE_TUNNEL_ID ?? '')) throw new Error('Set CONTROL_PLANE_TUNNEL_ID.');
  if (!/^sk-[A-Za-z0-9_-]+$/.test(env.CONTROL_PLANE_API_KEY ?? '')) throw new Error('Set CONTROL_PLANE_API_KEY.');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(env.YAHOO_CONNECTOR_TOKEN ?? '')) throw new Error('Set YAHOO_CONNECTOR_TOKEN.');
  const port = env.YAHOO_PORT ?? '8935';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Set a valid YAHOO_PORT.');
  const root = fileURLToPath(new URL('../', import.meta.url));
  return {
    command: env.TUNNEL_CLIENT_PATH || 'tunnel-client',
    args: ['runtimes', 'connect', '--alias', 'yahoo-mail-mcp',
      '--tunnel-id', env.CONTROL_PLANE_TUNNEL_ID,
      '--mcp-server-url', 'http://127.0.0.1:' + Number(port) + '/mcp',
      '--profile', 'yahoo-mail-mcp', '--profile-dir', join(root, 'runtime', 'profiles'),
      '--runtime-api-key', 'env:CONTROL_PLANE_API_KEY'],
    env: {
      ...env,
      MCP_EXTRA_HEADERS: 'X-Yahoo-Connector-Token: env:YAHOO_CONNECTOR_TOKEN',
      MCP_DISCOVERY_EXTRA_HEADERS: 'X-Yahoo-Connector-Token: env:YAHOO_CONNECTOR_TOKEN',
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = tunnelOptions();
    // Keep credentials in the child environment, never command arguments.
    const child = spawn(options.command, options.args, { env: options.env, stdio: 'inherit', shell: false });
    child.on('error', () => {
      console.error('Could not start tunnel-client. Install it or set TUNNEL_CLIENT_PATH.');
      process.exitCode = 1;
    });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
