import React, { useEffect, useState } from 'react';

// How close to the very bottom counts as "stuck" — a few px of slack so
// sub-pixel scroll math (common with fractional zoom levels) doesn't leave
// the button flickering in and out right at the actual bottom.
const NEAR_BOTTOM_PX = 24;

/**
 * A floating "back to top" button, shown only while `active` (the caller
 * decides when it's relevant — e.g. Flows only wants it once a run result is
 * on screen) AND the page is scrolled all the way to the bottom. The whole
 * app scrolls the window/body itself (no inner per-page container), so this
 * tracks window scroll directly rather than some ref'd element.
 *
 * `skipBottomCheck`: the caller has already decided exactly when this
 * should show (e.g. Flows tracks scroll position against a specific step's
 * element, not "the very bottom of the page") — show it whenever `active`
 * is true, without also requiring this component's own bottom-of-page check.
 */
export default function ScrollToTopButton({ active, skipBottomCheck = false }) {
  const [atBottom, setAtBottom] = useState(false);

  useEffect(() => {
    if (!active || skipBottomCheck) { setAtBottom(false); return; }
    const checkPosition = () => {
      const scrollHeight = document.documentElement.scrollHeight;
      const isScrollable = scrollHeight > window.innerHeight + NEAR_BOTTOM_PX;
      const scrolledToBottom = window.innerHeight + window.scrollY >= scrollHeight - NEAR_BOTTOM_PX;
      setAtBottom(isScrollable && scrolledToBottom);
    };
    checkPosition();
    window.addEventListener('scroll', checkPosition, { passive: true });
    window.addEventListener('resize', checkPosition);
    return () => {
      window.removeEventListener('scroll', checkPosition);
      window.removeEventListener('resize', checkPosition);
    };
  }, [active, skipBottomCheck]);

  if (!active || (!skipBottomCheck && !atBottom)) return null;

  return (
    <button
      className="scroll-to-top-btn"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      title="Back to top"
      aria-label="Scroll to top"
    >
      <svg viewBox="0 0 24 24" width="32" height="32">
        <path d="M12 1.3c2.1 2.1 3.2 5.2 3.2 8.9h-6.4c0-3.7 1.1-6.8 3.2-8.9z" fill="#e6472a" />
        <rect x="8.8" y="8.4" width="6.4" height="7.4" rx="3.2" fill="#eaf3fb" />
        <circle cx="12" cy="11.1" r="1.7" fill="#2f6fb3" />
        <path d="M8.8 12.8l-3.1 3.9 3.1-1.1v-2.8z" fill="#e6472a" />
        <path d="M15.2 12.8l3.1 3.9-3.1-1.1v-2.8z" fill="#e6472a" />
        <path d="M10.1 15.6c.6.3 1.2.5 1.9.5s1.3-.2 1.9-.5l-.7 2.9-1.2 1.9-1.2-1.9-.7-2.9z" fill="#f5a623" />
      </svg>
    </button>
  );
}
