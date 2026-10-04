# Running in the background

The foreground quick start works on Linux, Windows, and macOS. A background deployment must keep the Node process running, provide the required environment variables, retain the same encryption key/database, and allow outbound Yahoo IMAP (993) and SMTP (465). Events additionally need DNS and outbound HTTPS to callback receivers.

The authenticated `GET http://127.0.0.1:8935/readyz` endpoint confirms the HTTP listener is up. Send the connector token header. It does not check Yahoo credentials or tunnel health; use `yahoo_status` and the tunnel client's status command for those checks.

## Linux: systemd

For a personal installation, create `~/.config/systemd/user/yahoo-mail-mcp.service`. Replace both paths with your own absolute paths, including the actual Node binary path:

~~~ini
[Unit]
Description=Yahoo Mail MCP
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/your-user/yahoo-mail-mcp
ExecStart=/absolute/path/to/node --env-file=/home/your-user/yahoo-mail-mcp/.env /home/your-user/yahoo-mail-mcp/src/server.mjs
Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=default.target
~~~

~~~sh
systemctl --user daemon-reload
systemctl --user enable --now yahoo-mail-mcp
journalctl --user -u yahoo-mail-mcp
~~~

User services normally depend on the login session. If you require unattended operation after logout/reboot, arrange user lingering or an administrator-managed service for your host. Stop and disable with `systemctl --user disable --now yahoo-mail-mcp`.

## Windows: Task Scheduler

Create a task under the Windows account that owns the repository and data directory:

1. Add a trigger **At log on**, or a startup trigger with the credentials and permissions your deployment requires.
2. Add an action **Start a program**.
3. Set **Program/script** to the full path to `node.exe`, for example `C:\Program Files\nodejs\node.exe`.
4. Set **Arguments** to `--env-file="C:\Apps\yahoo-mail-mcp\.env" "C:\Apps\yahoo-mail-mcp\src\server.mjs"`.
5. Set **Start in** to `C:\Apps\yahoo-mail-mcp`.
6. Enable restart on failure and remove the task's execution time limit if it must run continuously.

Restrict the folder's Windows security permissions to the service account and necessary administrators. Validate the same command in PowerShell first. Task Scheduler's history helps diagnose launch failures; use a service wrapper if you need retained stdout/stderr logs. Stop the task and disable its trigger to turn it off.

## macOS: launchd

Create `~/Library/LaunchAgents/com.example.yahoo-mail-mcp.plist`. Replace paths with your own absolute paths; launchd does not expand `~`:

~~~xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.yahoo-mail-mcp</string>
  <key>ProgramArguments</key><array>
    <string>/absolute/path/to/node</string>
    <string>--env-file=/Users/your-user/yahoo-mail-mcp/.env</string>
    <string>/Users/your-user/yahoo-mail-mcp/src/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/your-user/yahoo-mail-mcp</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
~~~

~~~sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.yahoo-mail-mcp.plist
~~~

Stop it with `launchctl bootout gui/$(id -u)/com.example.yahoo-mail-mcp`, and remove the plist to prevent the next login from starting it. The machine must remain awake and logged in for this user agent.

## Secret managers and backups

All platform examples use a local env file for simplicity. A secret manager can instead inject the variables listed in the README and launch `node src/server.mjs` directly. Bitwarden Secrets Manager works through the same interface; macOS Keychain can be an optional bootstrap store for a local wrapper. Neither is required by this repository.

Protect the env file and state directory. Preserve `YAHOO_STATE_KEY` when moving machines. Stop the server before copying the database, then restore it with the same key and compatible configuration. Changing operating systems does not change the SQLite file format.

If using the OpenAI tunnel, supervise that component separately and check its status. A running mailbox server alone does not keep a remote tunnel connected. This repository does not install or modify OS services automatically.
