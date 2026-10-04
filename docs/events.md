# New-mail event contract

This server implements the webhook event interface described in [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), with discovery for protocol `2026-07-28`. Event support is an extension that requires a compatible client. The mail tools also support initialization with `2025-11-25`, `2025-06-18`, and `2025-03-26`.

Use the same authenticated `POST /mcp` endpoint for `events/list`, `events/subscribe`, and `events/unsubscribe`. Subscription identity is derived from the account principal, event name, normalized arguments, and callback URL.

Example subscription parameters, wrapped in a JSON-RPC request by the client:

~~~json
{
  "name": "yahoo.message.created",
  "arguments": {
    "mailbox": "INBOX",
    "from": "sender@example.com",
    "subject": "Invoice"
  },
  "delivery": {
    "mode": "webhook",
    "url": "https://receiver.example.com/callback",
    "secret": "whsec_REPLACE_WITH_BASE64_OF_32_RANDOM_BYTES"
  },
  "ttlMs": 86400000
}
~~~

Omitting arguments selects INBOX. Sender and subject filters are case-insensitive substring matches. Sender matching examines the display name and email address.

The receiver must answer the signed verification request by returning JSON with the exact `challenge` value. Callback URLs must use HTTPS on port 443 without URL credentials or fragments. Every DNS result must be a public unicast address; connections are pinned to a validated address and redirects are not followed. Receivers must verify Standard Webhooks signatures and deduplicate `webhook-id` values.

Responses contain an ID, finite `refreshBefore`, `cursor: null`, and `truncated: false`. The default and maximum lifetime are 24 hours. Refresh the same subscription before expiration to retain its position. A replacement signing secret has a 30-second overlap window.

Event data contains `mailbox`, `uid`, `uidValidity`, `messageId`, `subject`, `date`, and `from`. It contains message metadata, not the email body. Sender names and subjects remain untrusted content.

## Delivery limits

These limits describe this implementation:

- Polling occurs only while the process is running and subscriptions exist.
- New subscriptions begin at the current mailbox position.
- Each poll processes up to 100 new messages per subscription.
- The server supports at most 32 active subscription records.
- Active subscriptions and pending deliveries survive a restart with the same database and encryption key.
- A mailbox UID validity change establishes a new baseline.
- Expired subscriptions are removed along with their pending deliveries.
- There is no protocol replay cursor for recovering events after an expired subscription.
- Delivery is attempted up to eight times for connection failures, HTTP 408/429, and HTTP 5xx, using capped exponential backoff. Exhausted deliveries are discarded.
- HTTP 401, 403, or 410 removes the subscription. Other unsuccessful responses discard that delivery.
- Repeated deliveries use the same event ID; receivers should make processing idempotent.

Unsubscribe with the original event name, arguments, and delivery mode/URL. Repeated unsubscribe requests succeed. A callback already in flight may still complete.

The server does not assign a monitoring task, authorize actions, or guarantee client handling of an event. Live end-to-end delivery must be checked in your own client.
