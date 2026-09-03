import { stripJsonComments } from './jsonComments.js';

// Single-quotes a value for a POSIX shell — the only special case is an
// embedded single quote itself, closed out and re-opened around an escaped
// one: 'it'"'"'s' — the standard shell-quoting trick.
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function enabledHeaderEntries(headersRows) {
  return (headersRows || [])
    .filter((r) => r.enabled !== false && r.key.trim())
    .map((r) => [r.key.trim(), r.value]);
}

// A step whose Authorization comes from "Select account" (authCredentialId)
// has no raw header row to copy — the real token only exists once a run
// actually resolves that credential. A placeholder naming the account
// keeps the exported command runnable after a manual swap-in, instead of
// silently missing Authorization entirely.
function authPlaceholderHeader(step, authCredentials) {
  if (!step.authCredentialId) return null;
  const cred = authCredentials.find((c) => String(c.id) === String(step.authCredentialId));
  const label = cred ? cred.name : `account #${step.authCredentialId}`;
  return ['Authorization', `Bearer <token for "${label}" — paste a real one>`];
}

// Builds a `curl ...` command reproducing this step's request exactly as
// currently configured in the editor — method, URL, enabled headers, and
// body — for pasting into a terminal or sharing with someone outside the
// app. {{variable}}/{{id}}-style placeholders are copied through literally
// (there's nothing to resolve them against outside of an actual run), and
// a form-data file field becomes a `-F key=@"filename"` reference rather
// than embedding real file bytes.
export function stepToCurl(step, authCredentials = []) {
  const lines = [`curl --location --request ${step.method || 'GET'} \\`];
  lines.push(`  ${shQuote(step.url_template || '')} \\`);

  const headerEntries = enabledHeaderEntries(step.headersRows);
  const authHeader = authPlaceholderHeader(step, authCredentials);
  if (authHeader && !headerEntries.some(([k]) => k.toLowerCase() === 'authorization')) {
    headerEntries.push(authHeader);
  }
  for (const [key, value] of headerEntries) {
    lines.push(`  --header ${shQuote(`${key}: ${value}`)} \\`);
  }

  const bodyLines = [];
  if (step.bodyType === 'form-data') {
    for (const row of step.bodyRows || []) {
      if (row.enabled === false || !row.key.trim()) continue;
      const key = row.key.trim();
      if (row.type === 'file' && row.fileMeta) {
        const filename = row.fileMeta.__url__ ? (row.fileMeta.url || key) : (row.fileMeta.name || key);
        bodyLines.push(`  --form ${shQuote(`${key}=@"${filename}"`)} \\`);
      } else {
        bodyLines.push(`  --form ${shQuote(`${key}=${row.value ?? ''}`)} \\`);
      }
    }
  } else if (step.bodyType === 'json' && step.bodyText && stripJsonComments(step.bodyText).trim()) {
    bodyLines.push(`  --data-raw ${shQuote(stripJsonComments(step.bodyText))} \\`);
  }
  lines.push(...bodyLines);

  // Drop the trailing " \" continuation on the very last line.
  const last = lines[lines.length - 1];
  lines[lines.length - 1] = last.endsWith(' \\') ? last.slice(0, -2) : last;

  return lines.join('\n');
}
