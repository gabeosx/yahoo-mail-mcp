import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';

export class YahooMail {
  constructor({ email, password }) {
    this.email = email;
    this.password = password;
  }

  client() {
    return new ImapFlow({
      host: 'imap.mail.yahoo.com', port: 993, secure: true,
      auth: { user: this.email, pass: this.password },
      logger: false, disableAutoIdle: true,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    });
  }

  async imap(operation) {
    const client = this.client();
    client.on('error', () => {});
    try {
      await client.connect();
      return await operation(client);
    } finally {
      try { await client.logout(); } catch { client.close(); }
    }
  }

  smtp() {
    return nodemailer.createTransport({
      host: 'smtp.mail.yahoo.com', port: 465, secure: true,
      auth: { user: this.email, pass: this.password },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      logger: false, debug: false,
    });
  }

  async status() {
    const mailboxes = await this.imap(client => client.list());
    const transport = this.smtp();
    try { await transport.verify(); } finally { transport.close(); }
    return {
      email: this.email, imapAuthenticated: true, smtpAuthenticated: true,
      mailboxes: mailboxes.map(box => ({ path: box.path, specialUse: box.specialUse ?? null })),
    };
  }

  async mailboxState(path) {
    return this.imap(async client => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        return { uidValidity: String(client.mailbox.uidValidity), lastUid: client.mailbox.uidNext - 1 };
      } finally { lock.release(); }
    });
  }

  envelope(message, mailbox, uidValidity) {
    const address = items => (items ?? []).map(item => ({ name: item.name ?? '', address: item.address ?? '' }));
    return {
      mailbox, uid: message.uid, uidValidity: String(uidValidity),
      messageId: message.envelope?.messageId ?? '',
      date: message.internalDate?.toISOString() ?? null,
      subject: message.envelope?.subject ?? '',
      from: address(message.envelope?.from), to: address(message.envelope?.to),
      flags: [...(message.flags ?? [])], size: message.size ?? 0,
    };
  }

  async list({ mailbox = 'INBOX', limit = 20, unseen, from, subject, text, since, afterUid }) {
    return this.imap(async client => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const query = {};
        if (unseen !== undefined) query.seen = !unseen;
        if (from) query.from = from;
        if (subject) query.subject = subject;
        if (text) query.body = text;
        if (since) query.since = new Date(since);
        if (afterUid !== undefined) query.uid = `${afterUid + 1}:*`;
        if (!Object.keys(query).length) query.all = true;
        const found = await client.search(query, { uid: true });
        const ordered = found.filter(uid => afterUid === undefined || uid > afterUid).sort((a, b) => a - b);
        const selected = afterUid === undefined ? ordered.slice(-limit).reverse() : ordered.slice(0, limit);
        if (!selected.length) return { messages: [], uidValidity: String(client.mailbox.uidValidity) };
        const fetched = await client.fetchAll(selected.join(','), { envelope: true, internalDate: true, flags: true, size: true }, { uid: true });
        const messages = fetched.map(message => this.envelope(message, mailbox, client.mailbox.uidValidity));
        messages.sort((a, b) => afterUid === undefined ? b.uid - a.uid : a.uid - b.uid);
        return { messages, uidValidity: String(client.mailbox.uidValidity) };
      } finally { lock.release(); }
    });
  }

  checkValidity(client, expected) {
    if (String(client.mailbox.uidValidity) !== expected) throw new Error('Mailbox identifiers changed. List messages again before acting.');
  }

  async read({ mailbox, uid, uidValidity }) {
    return this.imap(async client => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        this.checkValidity(client, uidValidity);
        const metadata = await client.fetchOne(uid, { envelope: true, internalDate: true, flags: true, size: true }, { uid: true });
        if (!metadata) throw new Error('Message not found.');
        const result = this.envelope(metadata, mailbox, uidValidity);
        if (metadata.size > 5 * 1024 * 1024) return { ...result, untrustedContent: true, bodyUnavailable: 'Message exceeds the 5 MiB reading limit.' };
        const source = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!source?.source) throw new Error('Message no longer available.');
        const parsed = await simpleParser(source.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
        const text = parsed.text ?? '';
        return {
          ...result, untrustedContent: true, text: text.slice(0, 30_000), truncated: text.length > 30_000,
          attachments: parsed.attachments.map(item => ({ filename: item.filename ?? '', contentType: item.contentType, size: item.size })),
        };
      } finally { lock.release(); }
    });
  }

  message(input) {
    return {
      from: this.email, to: input.to, cc: input.cc, bcc: input.bcc,
      subject: input.subject, text: input.text,
      inReplyTo: input.inReplyTo, references: input.references,
      messageId: `<${input.requestId}@yahoo-dot.local>`,
      disableFileAccess: true, disableUrlAccess: true,
    };
  }

  async draft(input) {
    const content = await new MailComposer(this.message(input)).compile().build();
    return this.imap(async client => {
      const boxes = await client.list();
      const draft = boxes.find(box => box.specialUse === '\\Drafts');
      if (!draft) throw new Error('Yahoo Drafts mailbox could not be identified.');
      const appended = await client.append(draft.path, content, ['\\Draft', '\\Seen']);
      if (!appended) throw new Error('Draft save was not confirmed.');
      return { saved: true, mailbox: draft.path, uid: appended.uid ?? null, uidValidity: appended.uidValidity ? String(appended.uidValidity) : null };
    });
  }

  async send(input) {
    const transport = this.smtp();
    try {
      const result = await transport.sendMail(this.message(input));
      return { smtpAccepted: result.accepted.length > 0, messageId: result.messageId, accepted: result.accepted, rejected: result.rejected };
    } finally { transport.close(); }
  }

  async markRead({ mailbox, uid, uidValidity, read }) {
    return this.imap(async client => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        this.checkValidity(client, uidValidity);
        const exists = await client.fetchOne(uid, { uid: true }, { uid: true });
        if (!exists) throw new Error('Message not found.');
        const operation = read ? 'messageFlagsAdd' : 'messageFlagsRemove';
        const updated = await client[operation](uid, ['\\Seen'], { uid: true });
        if (!updated) throw new Error('Flag update was not confirmed.');
        return { updated: true, mailbox, uid, read };
      } finally { lock.release(); }
    });
  }
}
