# iLink transport

Independent protocol implementation. Wire fields were checked against the published
`@tencent-weixin/openclaw-weixin@2.4.8` package; no implementation code or runtime dependency
was imported from that package or the personal bridge repository.

```ts
const client = new ILinkClient({
  token: account.token,
  baseUrl: account.baseUrl,
});
const batch = await client.getUpdates(persistedCursor, signal);
// Commit messages + batch.get_updates_buf in one transaction before next poll.
const item = await client.uploadMedia(
  bytes,
  { toUserId: ownerId, kind: "file", fileName: "result.txt" },
  signal,
);
await client.send(
  { toUserId: ownerId, contextToken, clientId: durableOutboxId, items: [item] },
  signal,
);
```

`send` accepts a successful HTTP response with a valid JSON object and zero return status. iLink omits default-zero `ret` in normal responses, so an absent `ret` is also successful; explicit non-zero errors still fail. It never claims read/delivery,
accepts exactly one item per request (split captions and attachments into durable outbox entries),
never retries, and classifies an indeterminate response/network outcome as `uncertain`.
Persist that state for reconciliation; do not blindly retry. CDN upload itself does not
send a chat message. API error descriptions deliberately omit upstream response bodies,
URLs, bot tokens and media keys.

`getQrCode()` returns an opaque QR ID and QR content; display the latter as a QR image.
`getQrStatus(id, signal, verifyCode?)` exposes all known login states, including verification
and IDC redirection. A confirmed login must contain a bot and owner identity. The caller
owns QR expiry/retry state, account persistence, single-owner authorization and cancellation.
Only evidenced API/CDN hosts are accepted. New regional hosts require explicit protocol
verification and allowlist maintenance; redirects are never followed implicitly.

`message_id` and `seq` are losslessly parsed and normalized to strings. The caller must
validate owner, bot, group absence, message state and supported parts before execution.
Parts: 1=text (`text_item.text`), 2=image (`image_item`), 4=file (`file_item`).

Media uses bounded in-memory buffers (20 MiB images / 100 MiB files), AES-128-ECB/PKCS7
as required by the wire protocol, separate CDN requests without bot credentials, bounded
response reading, HTTPS host validation and disabled redirects. Concurrent media work
must be limited by the caller. Download verifies supplied file length and MD5. The module
does not write any attachment path or sanitize filenames; attachment storage owns that boundary.

Live login, account availability, media interoperability and context expiration remain
real-account acceptance checks; mock tests establish protocol and failure handling only.
