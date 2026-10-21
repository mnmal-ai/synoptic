// Shared stdin reader for hook executables. Hooks receive a JSON payload on
// stdin; a malformed or absent payload resolves to {} so callers never throw
// at the I/O boundary.

export async function readHookStdin(timeoutMs = 100) {
  if (process.stdin.isTTY) return {};
  const raw = await new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      resolve(data);
    });
  });
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
