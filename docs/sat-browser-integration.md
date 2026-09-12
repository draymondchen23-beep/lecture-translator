# Browser SaT integration

New browser-recognized lectures use the evaluated `sat-3l-sm` revision
`137da054051ad9f1eac42025f758db4ac9f22535`. The engine and numerical defaults are
unchanged from the local comparison (threshold .25, stride 128, block 256, hat
weighting). WASM uses one thread so the existing site needs no COOP/COEP changes.

The model runs in a module Worker. `predev`/`prebuild` generate same-origin static
metadata and vocabulary from the pinned Hugging Face cache (or download those
exact revisions on a clean machine). The existing site streams the public
408 MiB model as fixed 20 MiB HTTP ranges from Hugging Face; weight binaries are
not bundled in the site archive or committed. This avoids a 416 MB publication
upload which timed out twice. Browser Cache Storage retains verified chunks when quota
allows; cache failure does not prevent inference. No cloud inference service or
new runtime secret is added. The existing speech-recognition and translation
services remain responsible for audio transcription and Chinese translation.

`SatCaptionAccumulator` keeps the existing result-ID and consumed-word cursors.
A proposed boundary must occur in two distinct stable input snapshots and have
at least four following words before being committed. Silence, ASR final flags,
and the old 18-word/120-character limits do not commit SaT rows. Old inference
results cannot modify a corrected stable prefix or a consumed cursor. Draft
translations remain revision-bound. Explicit pause/end first drains recognition,
invalidates pending proposals, then segments the latest visible tail and retains
every word exactly once. Saved SaT rows bypass the legacy display re-splitter.

Only one inference runs at a time; current input coalesces naturally. Loading has
a 180-second timeout and a call has a 15-second timeout. A model error, unsupported
input, or pending text over 6,000 characters visibly falls back to existing rules.
Browsers without SpeechRecognition retain the existing server-backed path. Old
saved lecture records are not retrospectively resegmented.

Validation: TypeScript, production build, and 108 tests passed. Additional actual
WASM integration replay used the fixed MIT 401-word/53-cue comparison input:
28 rows committed before EOF, 29 final rows, all 401 words preserved, complete
13-word final sentence retained. Against the frozen rubric: 3 forbidden cuts
(131, 326, 344), 1 missed required boundary (130). This is a new streaming-policy
check, distinct from the earlier full-input SaT result (3 forbidden, 0 missed).
It does not establish real ASR accuracy or end-to-end latency. No browser UI QA
or live microphone run was claimed for this deployment.

Run regression checks with `node --test tests/*.test.mjs` after building; the SSR
smoke test imports the built server bundle. Model/library notices ship at
`/sat/NOTICE.txt` and `/sat/vendor/tokenizers-LICENSE`.
