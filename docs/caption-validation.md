# Caption validation evidence

## Verified

- The old transcript rendered separate English and Chinese scroll columns. The current transcript renders one ordered list of paired bilingual rows in a shared scroll container.
- Browser geometry at the default viewport: effective center target `416.17px`; first row `416.12px`, seventh row `416.16px`, and a late-completing earlier translation `415.92px` (all within 1px).
- Uploaded videos contain no audio: DeepL reference duration `66.90s`; local recording duration `21.79s`. They are visual references, not replayable speech inputs.
- Direct upstream speech test: socket OPEN `245ms`, `session.updated` `298ms`, first source `785ms`, first target `951ms`, `106` audio chunks. This is not browser audio end-to-end latency.
- Direct MT measurements: `425ms`, `325ms`, `399ms` (`373` total tokens: `342` input and `31` output); these are not full application-route measurements.
- Focused caption and follow-geometry tests pass 16/16 cases, including snapshot replacement, idempotent finals, punctuation boundaries, translation order, sticky-header/dock geometry, and long-row tails.

## Lifecycle and replay notes

Source and translation status are independent. A source draft can remain visible while translation is pending or draft; a late translation updates the original `segmentId` row. Final source revisions are rejected when older revisions arrive. The development replay fixture exercises this path without persistence, API, microphone, or audio side effects.

The 10-minute queue/repetition check is a virtual event replay, not 10 minutes of wall-clock classroom audio. Manual browser checks also confirmed that after `PageUp`, a new row leaves the reading anchor unchanged (`290.75px`), and `Jump to live` restores the latest row center (`409.61px` vs `409.67px`) and hides the button. No human classroom accuracy study has been run, and no same-input before/after recording has been delivered yet.
