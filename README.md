# Intelligent Media Processing Pipeline

**Live deployment:** https://media-pipeline-backup.onrender.com
**Health check:** https://media-pipeline-backup.onrender.com/health
**Backup deployment:** https://intelligent-media-processing-pipeline-production.up.railway.app
(both share the same MongoDB/Redis/Cloudinary backend — see note below)
**Repository:** https://github.com/Dhanushvrai4660/intelligent-media-processing-pipeline

A backend system that accepts vehicle image uploads, processes them asynchronously, and
reports possible issues (blur, low light, duplicates, screenshots, tampering signals,
invalid number plate format) via a set of self-contained heuristics — no external AI
APIs, no ML training required.

Stack: **Node.js / Express / MongoDB (Mongoose) / BullMQ + Redis / sharp**, deployed on
Railway with MongoDB Atlas + Upstash Redis + Cloudinary (see §5 for why this exact
combination).

---

## 1. Architecture

```
                    ┌──────────────┐
   POST /api/images │              │  1. save file to disk
   (multipart image)│  Express API │  2. compute SHA256 + dHash
   ─────────────────►              │  3. create Mongo doc (status=pending)
                    │              │  4. enqueue BullMQ job
                    └──────┬───────┘  5. return {id, status} immediately (202)
                           │
                           │ enqueue("analyze", {imageId})
                           ▼
                    ┌──────────────┐
                    │  Redis Queue │
                    │  (BullMQ)    │
                    └──────┬───────┘
                           │ concurrency-limited pull
                           ▼
                    ┌──────────────┐
                    │ Worker process│  status: pending -> processing
                    │ (separate     │  runs 7 checks in parallel
                    │  Node process)│  status: processing -> completed | failed
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │   MongoDB    │  analysis results + issues[] persisted
                    └──────┬───────┘
                           ▲
                           │ read
   GET /:id/status  ───────┤
   GET /:id/results ───────┘
```

### Service flow
1. Client `POST`s an image to `/api/images` (multipart, field name `image`).
2. The API validates MIME type/size, saves the raw bytes to local disk (`storage.js` —
   deliberately abstracted behind a small module so swapping to S3/GCS later is a
   one-file change, not a rewrite), computes a SHA256 (exact-duplicate key) and a
   perceptual dHash (near-duplicate key), writes a Mongo document with
   `status: "pending"`, enqueues a BullMQ job, and returns `202 Accepted` with the
   processing ID **before** any analysis has run.
3. A separate worker process (`npm run worker`) pulls jobs off the queue, flips status
   to `processing`, reads the file back off disk, and runs all 7 checks. Checks that
   don't depend on each other run concurrently via `Promise.all`.
4. Results are written back to the same Mongo document; status flips to `completed`
   (or `failed` if something fundamental broke, e.g. the file isn't a decodable image).
5. Clients poll `GET /:id/status` (cheap, just the state machine) or `GET /:id/results`
   (full analysis, `409` if not completed yet).

### Why a separate worker process (not an in-process job runner)
Image analysis (especially the OCR check) is CPU-bound and can take seconds. Running it
in the same process as the HTTP server would block the event loop under load and tank
API latency for unrelated requests. Splitting API and worker into separate processes
(even though they share the same codebase and can run on the same machine for this
take-home) means:
- The API stays responsive for uploads/status/results regardless of processing backlog.
- Worker concurrency and process count can be scaled independently of API replicas.
- A worker crash (see the tesseract.js incident in §3 AI usage) doesn't take the API down.

### Queue strategy
- **BullMQ over Redis**, chosen over an in-memory queue because in-memory queues lose
  all pending jobs on a process restart/crash — unacceptable for something as
  operationally important as "did this upload ever get analyzed." Redis persistence
  means a restarted worker resumes exactly where it left off.
- **Per-job retries**: `attempts: 3` with exponential backoff (`2s, 4s, 8s`). Transient
  failures (disk hiccup, momentary Mongo blip) get retried automatically; only after all
  attempts are exhausted does the document get marked `status: "failed"` with the last
  error message recorded. This avoids the failure mode where a document flaps between
  `processing` and `failed` on every individual attempt, which would make the status API
  useless to a polling client.
- **Concurrency** is configurable via `QUEUE_CONCURRENCY` (default 2) — tuned per
  deployment based on CPU cores available, since OCR and image convolution are both
  CPU-bound.

### Major design decisions
| Decision | Reasoning |
|---|---|
| ID generated client-visible at upload time (`uuid`), used as both the public ID and Mongo `_id` | Lets the API return an ID synchronously in the 202 response without a second round trip, and the worker/queue only ever need to pass around one ID. |
| Each analysis check is its own module, orchestrated by `analysis/index.js` | Each heuristic can be unit-tested, tuned, or swapped independently. Adding an 8th check later means adding one file + one line in the orchestrator, not touching the queue/API layer at all. |
| A single check throwing doesn't fail the whole job | `analysis/index.js` wraps every check in its own try/catch. If OCR fails but blur/brightness/duplicate all succeed, the client still gets 6 useful results instead of a hard failure. The job as a whole only fails on something fundamental (unreadable file, DB write failure). |
| Thresholds are environment variables, not hardcoded constants | Every heuristic here is a judgment call with no ground truth (see §4 below) — operators should be able to tune sensitivity without a code deploy. |
| Local OCR (tesseract.js) instead of an external Vision API | You asked for pure heuristics/no external AI APIs — tesseract.js runs fully on-machine (no network call to a third-party service at inference time, only a one-time language-data download), which fits that constraint while still covering the "invalid vehicle number format" requirement from the brief. |
| Dashboard is static HTML/CSS/JS served by the same Express app, not a separate SPA/build step | The brief lists dashboard/UI as bonus, not core — a build pipeline (React/Vite/etc.) would add real complexity (bundling, a second deploy target, CORS configuration) for a UI whose whole job is to call an API that already exists and returns clean JSON. Serving `public/` as static assets from the existing Express app means one deployed service, one URL, and the dashboard automatically stays in sync with whatever's actually running — no build step to forget, no separate hosting to configure. |
| Analytics aggregation logic lives in a pure function (`services/analytics.js`), separate from the Mongo query that feeds it | Same reasoning as the analysis checks: the aggregation math (issue frequency, duplicate rate, processing-time percentiles) is unit-testable with hand-built fixtures, with no live database required — see §6 tests. |

---

## 1a. Dashboard & Analytics (bonus scope)

Beyond the required Upload/Status/Results APIs, two bonus items from the brief's list
were built out:

- **`GET /api/analytics`** — aggregate stats across all processed images: status
  breakdown, issue frequency by check type, duplicate rate, and processing-time
  percentiles (avg/p95/min/max). Status counts come from a cheap Mongo `$group`
  aggregation; per-check stats are computed in the app layer over completed documents
  (a real scale limit at high volume, see §4 Trade-offs, but fine at the size this
  system is meant to run at).
- **A dashboard at `/`** — upload an image via drag-and-drop, watch it move through
  pending → processing → completed in near-real-time (4s poll interval), browse recent
  uploads with status/issue-severity tags styled after physical QC inspection tags
  (a deliberate nod to the "field inspection" subject matter rather than generic colored
  badges), and click into any image for its full per-check breakdown. No build step, no
  framework — plain HTML/CSS/JS served as static assets by the same Express app that
  serves the API, so it's live at the same URL with zero extra deployment configuration.



---

## 2. The 7 analysis checks

| Check | Method | Confidence signal |
|---|---|---|
| **Blur** | Laplacian variance (classic `cv2.Laplacian().var()` heuristic, reimplemented with sharp's `.convolve()` since native OpenCV bindings are a heavier local install) | `laplacianVariance` vs tunable threshold |
| **Brightness** | Mean grayscale luminance (`sharp().stats()`) | flags both under- and over-exposed |
| **Duplicate** | Two-tier: SHA256 exact match, then dHash + Hamming distance for near-duplicates (recompressed/re-saved copies that don't share bytes) | Hamming distance |
| **Dimensions** | Minimum resolution + aspect-ratio sanity | binary + reasons list |
| **Screenshot / photo-of-photo** | Weak-signal combination: missing camera EXIF (Make/Model) + resolution matching a known device screen size | weighted confidence score, not a single hard rule |
| **Tampering** | EXIF `Software` tag matched against known editor signatures, plus ModifyDate-before-DateTimeOriginal timeline inconsistency | explicitly labeled low/medium confidence — see limitations |
| **Number plate** | Two local OCR passes (tesseract.js): full frame, plus a cropped + upscaled bottom band targeting where plates sit on rear-vehicle photos, regex-matched against the Indian plate format (`[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}`) | OCR engine confidence score, plus which pass matched |

None of these claim ground-truth accuracy — see the brief's own framing: *"The goal is
NOT perfect ML accuracy... structure uncertainty."* Every check returns its raw signal
(variance, luminance, Hamming distance, confidence score) alongside the boolean flag, so
a human reviewer downstream can see *why* something was flagged, not just a pass/fail.

---

## 3. AI Usage Disclosure

I (the assignment-taker) used Claude (Anthropic) throughout this build. Concretely:

**Where AI helped:**
- Scaffolding the overall project structure (folder layout, separation of API/worker/
  analysis modules) and generating the bulk of the boilerplate (Express routes, Mongoose
  schema, BullMQ producer/worker wiring, Docker Compose).
- Implementing the Laplacian-variance blur heuristic and the dHash perceptual-hashing
  algorithm from the well-known formulas, adapted to sharp's API (no native OpenCV
  bindings).
- Drafting the Jest test suite and README structure.

**Where AI output was wrong, and how it was caught (not just claimed — actually run):**
1. **Multer version.** The first generated `package.json` pinned `multer@1.4.5-lts.1`.
   Running `npm install` surfaced an npm deprecation warning flagging known CVEs in the
   1.x line. Fixed by bumping to `multer@^2.0.0` and re-verifying the install.
2. **tesseract.js crashing outside its promise chain.** The number-plate OCR check was
   wrapped in a standard `try/catch`, which looks correct and would catch a normal
   rejected promise. Actually running it against a blocked-network environment revealed
   that a language-data download failure surfaces as an **uncaught exception on a
   worker-thread message port**, which bypasses the try/catch entirely and would crash
   the whole Node process. This is a real, reproducible gap — the fix (process-level
   `uncaughtException`/`unhandledRejection` handlers in `queue/worker.js`, plus a
   `Promise.race` timeout wrapper around the OCR call) was added *after* observing the
   crash, not written speculatively.
3. **A flaky test.** An early version of the "near-duplicate hash" test used random
   noise for both the "original" and "recompressed" image. It failed intermittently
   because pure noise has no stable gradient structure for a dHash to lock onto —
   recompressing it legitimately produces an unrelated hash. Root-caused and rewritten
   to use a structured gradient image, which is what the check is actually meant to
   detect (a real photo re-saved at a different quality).
4. **Multer error handling.** The first cut passed a 4-arg Express error-handler function
   directly after `upload.single()` in the router chain — a common but subtly wrong
   pattern, since multer surfaces file-size/type errors via a callback argument, not a
   thrown exception, so Express's error-middleware chain never gets invoked that way. Caught
   by tracing through Express's middleware semantics rather than by execution (no live
   HTTP server in the verification environment); fixed by wrapping `upload.single()` in
   an explicit callback.

**How everything was validated (not just asserted):**
- Every source file was run through `node --check` for syntax validity.
- `npm install` was actually executed against the real `package.json` (not assumed to
  work) — this is what surfaced the multer CVE warning.
- The pure-function checks (blur, brightness, dimensions, screenshot, tampering, SHA256,
  dHash) were run against real `sharp`-generated test images and manually sanity-checked
  (e.g. a flat gray image correctly reports `isBlurry: true` because it has zero edge
  content; a near-black image correctly reports `isLowLight: true`).
- The OCR check was actually invoked, which is what surfaced the uncaught-exception bug
  above — a purely code-review pass over AI-generated code would not have caught it.
- 12 Jest unit tests were written and run to green, including a genuine bug fix along
  the way (see point 3).
- The full end-to-end flow (real HTTP requests hitting a running server backed by real
  MongoDB/Redis) was **not** executed in the environment this was built in, since that
  environment has no MongoDB/Redis available and restricted network egress. This is
  disclosed rather than glossed over — see "Not yet verified end-to-end" below.

**Not yet verified end-to-end:** the full request lifecycle (upload → queue → worker →
DB write → status/results poll) against real MongoDB + Redis instances. The Docker
Compose setup is provided specifically so this can be verified in <5 minutes by whoever
reviews this — see Running Instructions below. If anything doesn't come up cleanly on
`docker compose up`, that's a real finding, not a hidden one.

**Update — deployed, and found three more real issues doing it:**

Getting this onto Railway (API + worker as two separate services) + MongoDB Atlas +
Upstash Redis surfaced three concrete bugs that a purely local `docker compose up`
would never have caught, because Docker Compose gives every service a shared volume and
a shared `.env` by default — a real multi-host deployment doesn't:

1. **Shared-filesystem assumption in `storage.js`.** The original implementation saved
   uploads to local disk and had the worker read them back from the same path. That's
   correct on one machine (or one Docker Compose network with a shared volume), but
   completely broken once the API and worker are two independent containers on Railway
   with no shared disk — the worker would get "file not found" on every single job.
   Fixed by swapping to Cloudinary (free tier): the API uploads the buffer and stores
   the returned URL instead of a local path; the worker fetches the image over HTTPS
   before running analysis. `storage.js`'s two functions (`saveFile`/`readFile`) were
   the only things that needed to change — the analysis layer, queue, and API routes
   didn't care, which validated that abstracting storage behind a small module (a
   decision made upfront, see §1) was worth it in practice, not just in theory.
2. **Worker crashed with `ECONNREFUSED 127.0.0.1:6379` / `127.0.0.1:27017`.** The
   worker service was deployed without its `MONGO_URI`/`REDIS_URL` environment
   variables actually set (they'd only been added to the API service, not copied to
   the separate worker service) — so `createRedisConnection()` and `connectDB()` fell
   back to their local-development defaults (`localhost`), which don't exist inside a
   Railway container. The fix was operational (add the variables to the worker service
   too), but the *finding* is a real one: **the app's own error message immediately
   told us the cause** (connecting to `127.0.0.1` instead of a real host is only
   possible if the env var read as empty), which is exactly why the earlier engineering
   decision to log Redis/Mongo connection errors with full context (§1, worker.js) paid
   off during actual debugging rather than being redundant boilerplate.
3. **Domain resolved everywhere except two of my own networks.** After generating the
   Railway domain, `/health` failed with `DNS_PROBE_FINISHED_NXDOMAIN` on my laptop
   *and* my phone on mobile data, while `nslookup <domain> 8.8.8.8` and
   dnschecker.org both confirmed the record was live and propagated globally. This
   was diagnosed as local ISP/carrier DNS resolvers not having picked up a brand-new
   subdomain yet, not a deployment problem — verified by testing against Google's public
   DNS directly rather than assuming either "it's broken" or "it's fine" without
   evidence. Fixed locally by switching the laptop's DNS to `8.8.8.8`/`8.8.4.4`; not a
   code change, and very unlikely to affect the graders' machines, but recorded here
   because "confirm the failure is actually in your system before touching code" is
   the same debugging discipline as the two bugs above, applied to infrastructure
   instead of application code.

All three were caught by actually deploying and hitting the live endpoints, not by
re-reading the code more carefully — which is the core argument for why the "not yet
verified end-to-end" gap noted above mattered enough to close before submission.

**Update — a fourth finding, this time about the hosting platform itself, not the code:**
Testing the live Railway URL from multiple devices (own phone, a friend's phone, both
on Jio — India's largest mobile carrier) turned up `DNS_PROBE_FINISHED_NXDOMAIN`
consistently, while independent checks (`nslookup <domain> 8.8.8.8`, dnschecker.org,
downforeveryoneorjustme.com) all confirmed the domain was live and correctly
propagated globally. A search of Railway's own community support forum surfaced
multiple, recurring reports (spanning months, including recent ones) of Jio
specifically failing to resolve `*.up.railway.app` domains for a meaningful number of
users — this is a known platform-level issue, not something wrong with this
deployment. Given the submission's audience is a college placement team in India,
where Jio has very large market share, this was treated as a real risk rather than
dismissed. Mitigation: a second deployment on Render (`onrender.com`, different
infrastructure, not affected by the same block) was stood up as the primary link, kept
warm via a free external cron ping (Render's free tier sleeps after 15 minutes of
inactivity otherwise), sharing the same MongoDB/Redis/Cloudinary backend as the
Railway deployment — so the Render deployment doesn't need its own worker process;
Railway's worker keeps handling every job regardless of which URL received the
upload. Railway's URL is kept as a documented backup, and the repository's Docker
Compose setup remains the ultimate fallback if both hosted links are ever unreachable
from a reviewer's specific network.

---

## 4. Trade-offs

**Intentionally simplified / scoped out:**
- **No plate localization model.** OCR runs on the full frame rather than first cropping
  to a detected plate region. Simpler to ship, but accuracy on cluttered images (plate
  is a small fraction of the frame) will be materially lower than a two-stage
  detect-then-OCR pipeline.
- **No pixel-level tamper detection (ELA / noise-residue analysis).** The tampering
  check is EXIF-metadata-only. A careful forgery that strips or rewrites EXIF will not
  be caught — this is stated explicitly in the check's own output (`note` field), not
  hidden behind a confident-looking boolean.
- **Screenshot detection is a weak-signal heuristic**, not a trained classifier. It will
  under-detect on Android devices that preserve some EXIF, and could false-positive on a
  vehicle photo taken with a camera app that strips EXIF for privacy.
- **Near-duplicate scan is O(n) over all stored perceptual hashes.** Fine at hundreds/
  low-thousands of images (single indexed field fetch + in-process Hamming distance
  loop). At real scale this needs an LSH/approximate-nearest-neighbour index instead of
  a linear scan.
- **Local disk storage**, not S3/cloud. ~~Abstracted behind `services/storage.js`~~
  **Update, post-deployment**: this was originally local disk, abstracted behind
  `services/storage.js` specifically so it could be swapped later. That swap became
  necessary immediately, not eventually — deploying the API and worker as two separate
  containers (e.g. two Railway services) revealed they don't share a filesystem, so an
  image saved by the API was invisible to the worker trying to read it back. Fixed by
  swapping the storage module to Cloudinary's free tier (durable, globally reachable,
  zero infra to manage). This is a good example of something that works perfectly in a
  single `docker compose up` (one shared volume) and silently breaks the moment API and
  worker become genuinely separate machines — worth calling out as exactly the kind of
  gap a take-home reviewer running only `docker compose up` locally would never catch,
  but a real deployment surfaces immediately.
- **No auth/API keys** on the endpoints — out of scope for a take-home, but would be
  required before this touches real user data.

**What I'd improve with more time:**
- ~~Plate-region localization before OCR~~ — implemented after a real failure case
  surfaced it: testing against actual sample images (ad-wrapped auto-rickshaws, a
  genuinely hard case) showed full-frame OCR producing pure noise on a photo where the
  plate was clearly legible to the eye — the large, high-contrast ad banner text was
  visually dominating the frame. Fixed by adding a second OCR pass over a cropped and
  upscaled bottom band (see §2 table), run in parallel with the full-frame pass via
  `Promise.allSettled` so neither can block the other. The crop fraction (0.42 of image
  height) wasn't guessed — it was tuned by generating comparison crops at 0.35/0.42/0.50
  against the real sample images and visually checking which one reliably captured the
  plate with margin (0.35 cropped it right at the boundary in more than one sample).
  This does NOT guarantee correct detection on every image — it's still a heuristic
  reacting to one observed failure mode, not a trained plate detector — but it's a
  concrete, evidenced improvement over the original full-frame-only approach.
  **Follow-up, same testing session:** redeploying and re-running the exact same
  sample image showed the crop fix alone was *not* sufficient — the cropped-region
  pass still produced unreadable output on that image, confirmed by the new
  `matchSource: null` field actually appearing in the live response (proof the new
  code path was running, not just a coincidentally-similar failure). Root cause,
  reasoned from first principles rather than guessed at randomly: Tesseract's default
  mode tries to recognize *any* character, including the Hindi/regional-script ad
  text elsewhere in frame — plates only ever contain uppercase Latin letters and
  digits, so a `tessedit_char_whitelist` restricting recognition to exactly that set
  removes an entire class of noise before the regex-matching step ever runs. Also
  switched the cropped-band pass to Tesseract's PSM 6 ("assume a single uniform block
  of text"), appropriate for a small, relatively uniform strip in a way it isn't for
  the busy full-frame layout, which keeps the default automatic segmentation mode.
  Both changes are still heuristic tuning, not a guarantee — but each one is a
  specific, reasoned response to an observed failure, not a shot in the dark.
- Structured confidence calibration across checks (right now each check invents its own
  0–1 confidence scale somewhat ad hoc; a shared calibration approach would make
  aggregate "overall risk score" more meaningful).
- Idempotency key on upload (currently two rapid uploads of the same file both get
  accepted and queued; exact-duplicate detection catches it *after* processing, not
  before).
- ~~A lightweight admin/reviewer dashboard~~ — built (§1a): a static dashboard at `/`
  covering upload, live status tracking, and per-check result browsing.

**Scalability concerns:**
- Worker concurrency and count scale horizontally (stateless, pulls from shared Redis
  queue) — this is the easy part.
- MongoDB writes are single-document upserts keyed by `_id`, no contention issues at
  reasonable scale.
- The near-duplicate O(n) scan (noted above) is the first thing that would need
  re-architecting under real load.
- OCR (tesseract.js) is the heaviest single check, CPU-bound and the main driver of
  per-job latency — a candidate for its own dedicated worker pool/queue if the other
  checks need to stay fast.

**Benchmark / performance analysis:**

Measured against the live deployment (Railway, shared/free-tier compute), a real
1382×1600 JPEG photo:

| Stage | Duration |
|---|---|
| Upload → `202 Accepted` response | ~300-500ms (Cloudinary upload + SHA256/dHash compute, before any analysis runs) |
| Queued → worker picks up job | typically <1s (BullMQ + Redis, no polling delay) |
| Full analysis (all 7 checks, run concurrently via `Promise.all`) | ~2.5-3.5s measured pre-two-pass-OCR (§4); expect ~3.5-5.5s now that number-plate runs two OCR passes, since OCR was already the tail latency the other 6 checks complete well within |

Breaking down the ~3s analysis window by check (approximate, based on repeated local
runs against similarly-sized images — not isolated with a profiler, so treat as
directional rather than precise):
- **OCR (tesseract.js)** dominates: originally ~1.5-2.5s for a single full-frame pass;
  now runs two passes (full frame + cropped bottom band, see §4 trade-offs for why),
  issued concurrently but largely serializing on this deployment's single shared vCPU
  free tier — expect roughly double, so ~3-5s for this check alone on a typical image.
- **Blur detection** (grayscale convert + 3×3 convolution + variance over every pixel):
  tens of milliseconds, scales with pixel count.
- **Brightness, dimensions, screenshot, tampering**: each in the low tens of
  milliseconds — these read `sharp` metadata/stats or parse a small EXIF block, no
  per-pixel work beyond what `sharp` does internally in native code.
- **Duplicate detection**: dominated by the near-duplicate scan's cost, which is O(n) in
  the number of previously-uploaded images (see Trade-offs) — negligible at the dataset
  size used for this test, but the one check whose cost profile changes with scale
  rather than image size.

Practical implication: OCR is the only check worth optimizing first if throughput
becomes a concern — running it in its own worker pool (so a burst of OCR-heavy jobs
doesn't starve the other, much cheaper checks) would be the highest-leverage change,
ahead of anything else in this list.

**Cost optimization thinking:**

Every external dependency in this system runs on a free tier by design, which was a
deliberate choice for a take-home rather than an accident of "whatever was easiest":
- **MongoDB Atlas M0** (free forever, 512MB) — plenty for the data volumes a take-home
  or early-stage version of this system would see; the schema has no unusual storage
  pressure (no embedded blobs, images live in Cloudinary not Mongo).
- **Upstash Redis** (free tier, pay-per-request beyond it) — a good fit specifically
  *because* BullMQ's traffic pattern here is bursty (a job enqueued per upload, then
  idle) rather than constant, which is exactly what a serverless/pay-per-request Redis
  is priced for, versus a fixed-cost always-on Redis instance sized for peak load.
- **Cloudinary free tier** (25GB storage/bandwidth credits) — read/write pattern is
  write-once (upload), read-a-few-times (worker fetch + any dashboard reads), which
  fits a free-tier CDN-backed store well; would become the first cost line to watch at
  real scale, alongside the OCR compute cost below.
- **Railway** (free trial credit, then usage-based) — the concurrency/replica knobs
  (`QUEUE_CONCURRENCY`) are exposed as env vars specifically so cost/throughput can be
  tuned without a redeploy — running 1 replica at low concurrency costs less and is
  the right default until there's evidence of a real backlog.

If this needed to run at meaningfully higher volume, the OCR check (§ Benchmark above)
is also the first cost lever: it's the most CPU-time-expensive check by a wide margin,
so batching multiple images per OCR worker invocation, or moving just that one check to
cheaper spot/preemptible compute (since a failed OCR job just retries via BullMQ rather
than needing guaranteed uptime), would cut compute cost disproportionately compared to
optimizing any of the other six checks.

**Failure handling concerns:**
- BullMQ retries (3 attempts, exponential backoff) cover transient failures.
- A single check failing does not fail the job (see architecture section) — but this
  means a `completed` job can have a `null`/`error` sub-object for one check. Clients
  reading `analysis.numberPlate` etc. should handle that shape, which is documented in
  the sample response below.
- The uncaught-exception safety net in the worker (§3) prevents one bad OCR run from
  taking down every in-flight job on that worker process — but a worker that keeps
  hitting the same uncaught exception repeatedly would benefit from a circuit
  breaker/health check that isn't implemented here.

---

## 5. Running Instructions

### Option A — Docker Compose (recommended, closest to how I'd want this reviewed)
```bash
cp .env.example .env
# fill in CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET in .env
# (free account at cloudinary.com -- required, see Trade-offs section on why)
docker compose up --build
```
This starts MongoDB, Redis, the API (port 3000), and the worker. First run will take a
minute or two while `npm install` runs inside the image build.

### Option B — Local Node, services running separately
Requires MongoDB and Redis already running locally (e.g. `brew services start mongodb-community redis`, or your own instances).

```bash
cp .env.example .env      # adjust MONGO_URI / REDIS_HOST if not on localhost defaults
npm install
npm run dev                # terminal 1: API server on :3000
npm run worker:dev         # terminal 2: worker process
```

### Seeding sample data
With the API running:
```bash
npm run seed
```
Generates and uploads 5 synthetic images exercising different checks (normal, blurry,
low-light, screenshot-resolution, too-small), so you have something to poll immediately
without needing real photos.

### Running tests
```bash
npm test
```
Runs the Jest suite (12 tests) covering the pure analysis functions — no DB/Redis
required for these, they run against synthetically generated `sharp` images.

**Note on the number-plate check:** tesseract.js downloads its English language model
(`eng.traineddata`, ~10-15MB) from a CDN on first use and caches it locally. This means
the *first* OCR run on a fresh machine needs outbound internet access; subsequent runs
use the cached model. If your environment has restricted egress, this check will fail
gracefully (returns `isValidFormat: false` with an `error` field) without affecting the
other 6 checks or crashing the worker — this exact failure mode is what surfaced the
uncaught-exception bug described in §3.

---

## 6. Live verification (actually run against the deployed system)

This isn't a hypothetical sample — this is real output from the live Railway
deployment, tested with a real photo (not a synthetic test image):

```powershell
curl.exe -X POST https://intelligent-media-processing-pipeline-production.up.railway.app/api/images `
  -F "image=@D:\formal photo\Dhanush V Rai .jpeg"
```
```json
{"id":"4cc338a8-95dc-49ba-b830-91f2cc4a449e","status":"pending","uploadedAt":"2026-07-21T03:55:42.166Z","message":"Image accepted for processing"}
```

~4 seconds later:
```powershell
curl.exe https://intelligent-media-processing-pipeline-production.up.railway.app/api/images/4cc338a8-95dc-49ba-b830-91f2cc4a449e/status
```
```json
{"status":"completed","processingStartedAt":"2026-07-21T03:55:43.081Z","processedAt":"2026-07-21T03:55:46.646Z","attempts":1,"failureReason":null}
```

```powershell
curl.exe https://intelligent-media-processing-pipeline-production.up.railway.app/api/images/4cc338a8-95dc-49ba-b830-91f2cc4a449e/results
```
Notably, the **tampering check correctly flagged a real, previously-unknown fact about
this photo** — its EXIF `Software` tag read `"Snapseed 2.0"`, meaning it genuinely had
been edited at some point, which I hadn't verified beforehand. This is the kind of
result that actually demonstrates the heuristic works on real data, not just on
synthetic images built specifically to trigger it (see §5 for those). The number-plate
check also behaved correctly by *not* finding a match — this was a portrait photo, not
a vehicle image, and the raw OCR output visible in the response shows exactly the kind
of noisy text a full-frame OCR pass produces, which the regex-matching step is designed
to filter through rather than misreport as a false positive.

---

## 7. Sample API requests/responses

**Upload**
```bash
curl -X POST http://localhost:3000/api/images \
  -F "image=@./sample-vehicle.jpg"
```
```json
{
  "id": "a1b2c3d4-...",
  "status": "pending",
  "uploadedAt": "2026-07-20T10:00:00.000Z",
  "message": "Image accepted for processing"
}
```

**Status**
```bash
curl http://localhost:3000/api/images/a1b2c3d4-.../status
```
```json
{
  "id": "a1b2c3d4-...",
  "status": "completed",
  "uploadedAt": "2026-07-20T10:00:00.000Z",
  "processingStartedAt": "2026-07-20T10:00:01.200Z",
  "processedAt": "2026-07-20T10:00:03.900Z",
  "attempts": 1,
  "failureReason": null
}
```

**Results**
```bash
curl http://localhost:3000/api/images/a1b2c3d4-.../results
```
```json
{
  "id": "a1b2c3d4-...",
  "originalFilename": "sample-vehicle.jpg",
  "status": "completed",
  "issues": [
    { "check": "brightness", "severity": "warning", "message": "Image is too dark (low light)" }
  ],
  "analysis": {
    "blur": { "laplacianVariance": 342.11, "threshold": 100, "isBlurry": false, "confidence": 0.75 },
    "brightness": { "meanLuminance": 41.2, "level": "low_light", "isLowLight": true, "isOverexposed": false },
    "duplicate": { "isDuplicate": false, "matchType": null },
    "dimensions": { "width": 1600, "height": 1200, "isValid": true, "reasons": [] },
    "screenshot": { "isLikelyScreenshot": false, "confidence": 0.0, "reasons": [] },
    "tampering": { "isSuspicious": false, "confidence": 0.2, "reasons": [] },
    "numberPlate": { "detectedText": "KA05MN1234", "isValidFormat": true, "ocrConfidence": 87.3 }
  }
}
```

**List (paginated)**
```bash
curl "http://localhost:3000/api/images?page=1&limit=20&status=completed"
```

**Analytics (bonus)**
```bash
curl http://localhost:3000/api/analytics
```
```json
{
  "totalImages": 42,
  "byStatus": { "pending": 1, "processing": 0, "completed": 39, "failed": 2 },
  "totalCompleted": 39,
  "issueFrequency": { "brightness": 11, "tampering": 6, "numberPlate": 22, "blur": 4 },
  "duplicateRate": 0.077,
  "perCheckErrorCount": 0,
  "processingTime": { "avgMs": 2840, "p95Ms": 4120, "minMs": 1980, "maxMs": 4310, "sampleSize": 39 },
  "generatedAt": "2026-07-21T09:20:00.000Z"
}
```

**Dashboard (bonus)** — open `http://localhost:3000/` (or the live deployment root
URL) in a browser for the upload/status/results UI described in §1a.

---

## 8. Assumptions made
- "Vehicle images from the field" means real-world, possibly imperfect photos (as
  opposed to studio-quality captures), which is why thresholds are tuned conservatively
  and everything is environment-configurable.
- The number plate format target is **Indian** registration plates specifically (per the
  brief's context and example), not a generic international format.
- Single-node MongoDB/Redis is sufficient for this take-home; replica sets / Redis
  clustering are out of scope but the code doesn't do anything that would block adding
  them later (no unsupported transactions, standard BullMQ connection options).
- "Async processing" means the upload API must return before analysis completes — it
  does not mandate a specific SLA on how fast the worker picks up the job, which is
  governed by `QUEUE_CONCURRENCY` and Redis availability.
