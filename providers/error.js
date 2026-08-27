// Provider SDKs/APIs tend to throw errors whose .message is a huge raw JSON
// blob (sometimes with a stack trace mixed in). Reduce that to "<label> <status>:
// <human reason>" so logs stay readable, while keeping .status for callers.
export function providerError(label, status, rawMessage) {
  let detail = rawMessage;
  const jsonStart = detail.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(detail.slice(jsonStart));
      detail = parsed.error?.message || parsed.message || detail;
    } catch {
      // not JSON, fall through and use the raw message
    }
  }
  detail = detail.split('\n')[0].trim();

  const err = new Error(status ? `${label} ${status}: ${detail}` : `${label}: ${detail}`);
  err.status = status;
  return err;
}
