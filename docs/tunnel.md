# Optional OpenAI tunnel

The core server works with any compatible HTTP MCP client. For private access from supported OpenAI products, use [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). The tunnel client runs beside this server and connects outbound, keeping the mailbox listener on loopback.

Install the appropriate `tunnel-client` binary from the [official releases](https://github.com/openai/tunnel-client/releases/latest) for your operating system. Put it on PATH, or set `TUNNEL_CLIENT_PATH` to the full executable path in `.env`. On Windows use the native `.exe`.

Create a tunnel in [Platform settings](https://platform.openai.com/settings/organization/tunnels), associate it with your intended account/workspace, and create a runtime API key whose principal has **Tunnels Read + Use**. Creation and administration require separate permissions. Follow the official guide for current availability and account-specific setup.

Add your own values to `.env`:

~~~dotenv
CONTROL_PLANE_TUNNEL_ID=tunnel_your_own_id
CONTROL_PLANE_API_KEY=your_own_runtime_api_key
~~~

The real tunnel ID must be `tunnel_` followed by 32 lowercase hexadecimal characters. The runtime key must be a complete `sk-` key. The example placeholders are not valid credentials.

Keep `npm start` running. In another terminal in this repository, run:

~~~sh
npm run tunnel
tunnel-client runtimes status yahoo-mail-mcp
~~~

The portable launcher uses your configured port and forwards the connector token through both normal and discovery headers. It keeps credentials in the child environment and references them from generated profiles. It does not create a tunnel or call Yahoo itself.

Confirm the tunnel is running, healthy, and ready before connecting it from your OpenAI client. Use the [official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) for the current UI and authorization requirements.

Stop the managed tunnel with:

~~~sh
tunnel-client runtimes stop yahoo-mail-mcp
~~~

Publishing this source repository does not publish a ChatGPT plugin or provide anyone with a hosted mailbox service. The tunnel guide describes private developer connections and explains the separate requirements for public plugin distribution.
