// JSON itself has no comment syntax — this is purely an editor convenience
// (Cmd+/ / Ctrl+/, same as a real code editor) for temporarily disabling
// one or more lines of a step's JSON body while testing, without deleting
// them. A commented line is prefixed with "// " after its own indentation,
// e.g. `  "foo": 1,` becomes `  // "foo": 1,`. stripJsonComments() below
// removes that prefix (and any resulting dangling trailing comma) before
// the text is ever actually parsed as real JSON.
const COMMENT_PREFIX = '// ';

function lineIndexAt(text, offset) {
  return text.slice(0, offset).split('\n').length - 1;
}

// Toggles a "// " prefix on every line touched by [selectionStart,
// selectionEnd) — commenting if any touched non-blank line isn't already
// commented, uncommenting only if EVERY touched non-blank line already is
// (matching typical code editor Cmd+/ behavior). Blank lines are left
// alone either way. Returns the new text plus a selection range shifted to
// keep the same relative position within the (now differently-indented)
// lines, so typing can continue naturally right after the toggle.
export function toggleLineComment(text, selectionStart, selectionEnd) {
  const lines = text.split('\n');
  let startLine = lineIndexAt(text, selectionStart);
  let endLine = lineIndexAt(text, selectionEnd);
  // A selection that ends exactly at the start of a line (e.g. triple-click
  // selecting one whole line including its trailing newline) shouldn't drag
  // that next, otherwise-untouched line into the toggle.
  if (endLine > startLine && selectionEnd > 0 && text[selectionEnd - 1] === '\n') endLine -= 1;

  const touched = lines.slice(startLine, endLine + 1).filter((l) => l.trim() !== '');
  const isCommented = (line) => line.trimStart().startsWith('//');
  const allCommented = touched.length > 0 && touched.every(isCommented);

  // changes[i] = { at, delta } — `at` is the char offset within the ORIGINAL
  // line where the prefix was inserted/removed, `delta` the resulting
  // length change (positive when commenting, negative when uncommenting).
  const changes = lines.map(() => null);
  const newLines = lines.map((line, i) => {
    if (i < startLine || i > endLine || line.trim() === '') return line;
    const indent = line.match(/^\s*/)[0];
    const rest = line.slice(indent.length);
    if (allCommented) {
      if (rest.startsWith(COMMENT_PREFIX)) {
        changes[i] = { at: indent.length, delta: -COMMENT_PREFIX.length };
        return indent + rest.slice(COMMENT_PREFIX.length);
      }
      if (rest.startsWith('//')) {
        changes[i] = { at: indent.length, delta: -2 };
        return indent + rest.slice(2);
      }
      return line;
    }
    changes[i] = { at: indent.length, delta: COMMENT_PREFIX.length };
    return indent + COMMENT_PREFIX + rest;
  });

  const newText = newLines.join('\n');

  // Maps one absolute offset in the OLD text to its equivalent in the NEW
  // text: every full line before it shifts the offset by that line's own
  // delta (plus 1 for the newline, already baked into `lines` positions
  // since we recompute per-line below); a position within the changed line
  // itself only shifts if it falls at/after the insertion point.
  const mapOffset = (offset) => {
    let oldPos = 0;
    let newPos = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].length;
      const change = changes[i];
      const lineDelta = change ? change.delta : 0;
      if (offset <= oldPos + lineLen) {
        const withinLine = offset - oldPos;
        const shifted = change && withinLine >= change.at ? withinLine + lineDelta : withinLine;
        return newPos + Math.max(0, shifted);
      }
      oldPos += lineLen + 1;
      newPos += lineLen + lineDelta + 1;
    }
    return newPos;
  };

  return {
    text: newText,
    selectionStart: mapOffset(selectionStart),
    selectionEnd: mapOffset(selectionEnd),
  };
}

// Removes every full-line "//"-prefixed comment (leading whitespace then
// "//") before the text is parsed as real JSON, then collapses any comma
// left dangling directly before a closing `}`/`]` as a result (the common
// case: the last field before a closing brace got commented out, or the
// comment itself carried the trailing comma).
export function stripJsonComments(text) {
  const withoutComments = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return withoutComments.replace(/,(\s*[}\]])/g, '$1');
}
