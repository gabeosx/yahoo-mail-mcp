# Contributing

Use Node.js 22.13 or newer. Clone the repository, run `npm ci --ignore-scripts`, then:

~~~sh
npm run check
npm test
~~~

No Yahoo credentials are needed for the tests. Keep tests synthetic; do not send real mail from CI. Add a regression test when changing send deduplication, mailbox UID handling, event delivery, authentication, or configuration.

Keep npm scripts portable across Linux, Windows, and macOS. Use Node APIs for filesystem/process operations, resolve repository paths with `fileURLToPath`, and avoid shell-specific environment assignment, path separators, and wildcard expansion. CI exercises Node.js 22 and 24 on all three operating systems.

Open an issue or pull request with the behavior being changed, a reproducible example, and relevant validation. Remove email contents, credentials, callback URLs, and private account/deployment identifiers from examples and logs. Never attach your `.env` or runtime database.
