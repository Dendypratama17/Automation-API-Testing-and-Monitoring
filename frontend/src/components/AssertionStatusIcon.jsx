import React from 'react';
import { CheckIcon, XIcon } from './icons.jsx';

// Plain white checkmark when an assertion passed; a plain red X when it
// didn't — no background circle, used instead of a PASS/FAIL text badge.
export default function AssertionStatusIcon({ passed }) {
  if (passed) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, flexShrink: 0 }} title="PASS">
        <CheckIcon style={{ color: '#fff' }} width={14} height={14} />
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, flexShrink: 0 }} title="FAIL">
      <XIcon style={{ color: 'var(--fail)' }} width={16} height={16} />
    </span>
  );
}
