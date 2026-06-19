# Identity Vault

Identity Vault is a document ingestion and autofill system for identity records stored in Google Drive. It signs users in, syncs a Drive folder, parses identity documents with AI and OCR-like helpers, stores the results in PostgreSQL, encrypts sensitive vault data, and exposes an autofill mapping API for browser-based form filling.

## What this project does

The app is built around three main workflows:

1. Authentication
   - Users sign up or log in with email and password.
   - The backend creates a session token and stores it in PostgreSQL.
   - Later requests use `Bearer` auth to access vault data and sync jobs.

2. Drive sync and parsing
   - A user submits a Google Drive folder URL.
   - The backend recursively lists all files in the folder.
   - Files are grouped by person and document type.
   - PDFs, images, and text files are processed and sent to an AI model for extraction.
   - Parsed identity data is stored in a structured vault and encrypted before persistence.

3. Autofill mapping
   - A browser extension or client can send a DOM schema plus a user instruction.
   - The backend looks up the decrypted vault.
   - It maps form fields to values or document downloads using heuristics and an LLM fallback.

## Tech Stack

### Frontend

- React 19
- Vite
- Plain CSS for the current dashboard UI

### Backend

- Node.js
- Express
- Next-style API route handlers under `src/pages/api`
- PostgreSQL via `pg`

### AI and document processing

- Google Generative AI SDK (`@google/generative-ai`)
- OpenAI SDK used with an NVIDIA-compatible base URL for autofill mapping
- `pdf-parse` for text extraction from PDFs
- `sharp` for image conversion, resizing, and PDF page rendering

### Integrations

- Google Drive API via `googleapis`
- Optional Firebase Admin dependency is present in `package.json`, but the current codebase uses PostgreSQL-backed auth instead of Firebase auth

### Security and crypto

- `crypto-js` for AES encryption/decryption of vault content
- `jose` is installed but not currently used in the visible auth flow

## Project Structure

The main app lives in [`next-app`](./next-app).

Important files:

- [`src/db.js`](./next-app/src/db.js): PostgreSQL schema creation and data access helpers
- [`src/lib/encryptionUtils.js`](./next-app/src/lib/encryptionUtils.js): encrypt/decrypt helpers and deep object traversal
- [`src/lib/driveClient.js`](./next-app/src/lib/driveClient.js): Google Drive auth, folder crawling, and file download helpers
- [`src/lib/documentParser.js`](./next-app/src/lib/documentParser.js): alternate document parsing and family-tree utilities
- [`src/lib/groupingEngine.js`](./next-app/src/lib/groupingEngine.js): file grouping heuristics by name/type/time
- [`src/lib/recencyEngine.js`](./next-app/src/lib/recencyEngine.js): variant selection by document date/completeness
- [`src/pages/index.jsx`](./next-app/src/pages/index.jsx): admin dashboard UI
- [`src/pages/api/auth/login.js`](./next-app/src/pages/api/auth/login.js): login endpoint
- [`src/pages/api/auth/signup.js`](./next-app/src/pages/api/auth/signup.js): signup endpoint
- [`src/pages/api/auth/verify.js`](./next-app/src/pages/api/auth/verify.js): token verification and auth helpers
- [`src/pages/api/vault/sync.js`](./next-app/src/pages/api/vault/sync.js): Drive sync and vault build pipeline
- [`src/pages/api/vault/profiles.js`](./next-app/src/pages/api/vault/profiles.js): returns decrypted vault data
- [`src/pages/api/vault/status.js`](./next-app/src/pages/api/vault/status.js): sync job status lookup
- [`src/pages/api/vault/seed.js`](./next-app/src/pages/api/vault/seed.js): manual vault seeding endpoint
- [`src/pages/api/autofill/map.js`](./next-app/src/pages/api/autofill/map.js): autofill mapping endpoint for browser/forms

## How the system works

### 1. Authentication flow

The auth API uses a simple session model backed by PostgreSQL.

- `POST /api/auth/signup`
  - Accepts `{ email, password }`
  - Creates a new user row if the email does not already exist
  - Creates a session token valid for 7 days

- `POST /api/auth/login`
  - Accepts `{ email, password }`
  - Verifies the stored password
  - Issues a new session token on success

- `verifyToken()` in [`src/pages/api/auth/verify.js`](./next-app/src/pages/api/auth/verify.js)
  - Reads `Authorization: Bearer <token>`
  - Checks the `sessions` table
  - Returns the user identity used by other endpoints

Note: passwords are currently compared directly in code, so this is not a production-grade password hashing flow.

### 2. PostgreSQL storage layer

[`src/db.js`](./next-app/src/db.js) creates and manages the database schema on demand.

Tables:

- `users`
- `sessions`
- `vaults`
- `sync_jobs`
- `ingestion_failures`
- `archived_documents`

This file also exposes helper functions such as:

- `getUserByEmail`
- `createUser`
- `createSession`
- `getSession`
- `getVault`
- `setVault`
- `createSyncJob`
- `updateSyncJob`
- `getSyncJob`
- `addIngestionFailure`
- `addArchivedDocument`

### 3. Google Drive sync pipeline

[`src/pages/api/vault/sync.js`](./next-app/src/pages/api/vault/sync.js) is the main ingestion endpoint.

High-level sequence:

1. Verify the session token.
2. Create a sync job row.
3. Extract the folder ID from the supplied Google Drive URL.
4. Recursively crawl the folder with the Drive API.
5. Group files by person and document type.
6. Fetch file contents from Drive.
7. Extract text from PDFs and text files.
8. Render scanned PDFs to images when text extraction fails.
9. Send images and text to Gemini for structured JSON extraction.
10. Assign parsed data to a family profile or asset bucket.
11. Encrypt the vault and save it to PostgreSQL.
12. Mark the sync job as completed or failed.

The sync job is asynchronous. The endpoint returns immediately with a `jobId`, and the UI polls `/api/vault/status?jobId=...` until the job completes.

### 4. Document grouping and parsing

The ingestion pipeline uses filename and folder path heuristics to determine:

- Which person a file belongs to
- Which document type it is
- Whether multiple files should be treated as front/back sides or multiple versions of the same document

Document types currently recognized include:

- Aadhaar
- PAN
- Passport
- Driving licence
- Voter ID
- Land deed / property documents

Parsing strategy:

- PDFs
  - Attempt text extraction first with `pdf-parse`
  - If the PDF appears scanned or textless, render pages to images with `sharp`
- Images
  - Sent directly to the generative model
- Text files
  - Read as UTF-8 and appended to the model prompt as supporting context

The model is prompted to return JSON only, and the code strips code fences and tries to recover JSON from the model response if needed.

### 5. Vault shape

The vault is a structured JSON object containing:

- `ownerId`
- `lastSynced`
- `familyTree`
- `profiles`
- `assets`

Profiles generally contain:

- `personalDetails`
- `identities`
- `documents`

Assets contain land/property-related records such as deed metadata.

Before saving, sensitive branches like `profiles` and `assets` are deeply encrypted with AES using `ENCRYPTION_KEY`.

When data is served back to authenticated clients, the server decrypts it on the fly.

### 6. Autofill mapping

[`src/pages/api/autofill/map.js`](./next-app/src/pages/api/autofill/map.js) is the form-filling brain.

It accepts:

- `userInstruction`
- `domSchema`

Then it:

1. Verifies the user session.
2. Loads the vault.
3. Decrypts the vault data.
4. Uses local heuristics to infer common fields like:
   - name
   - DOB
   - gender
   - address
   - spouse/father/mother/child names
   - Aadhaar/PAN/passport numbers
5. Detects file-upload fields and maps them to document keys like:
   - `aadhaar`
   - `pan`
   - `passport`
   - `voterCard`
   - `drivingLicense`
   - `photo`
   - `resume`
6. If the heuristics are not confident enough, it optionally calls an LLM to improve the mapping.
7. Resolves actual Drive file IDs for file uploads.
8. Returns a JSON array of field mappings.

This endpoint is designed to be used by a browser extension or another UI that can inspect the DOM of a form.

## Environment Variables

The app expects the following environment variables:

- `DATABASE_URL`
  - PostgreSQL connection string
- `ENCRYPTION_KEY`
  - AES key used for vault encryption
- `GOOGLE_SERVICE_ACCOUNT_JSON`
  - Full service account JSON string, optional
- `GOOGLE_APPLICATION_CREDENTIALS`
  - Path to a service account JSON file, optional
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
  - Alternative service account fields, optional
- `GOOGLE_API_KEY`
  - Used for the autofill mapping LLM path
- `ANTHROPIC_API_KEY`
  - Also accepted by the autofill code as a fallback API key variable

## Google Drive credential loading order

[`src/lib/driveClient.js`](./next-app/src/lib/driveClient.js) checks credentials in this order:

1. `GOOGLE_SERVICE_ACCOUNT_JSON`
2. `GOOGLE_APPLICATION_CREDENTIALS`
3. `next-app/service-account.json`
4. A matching JSON file in the user Downloads folder
5. `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`

If none are present, the Drive sync code throws a clear setup error.

## Running the app

From the `next-app` folder:

```bash
npm install
npm run dev
```

Other scripts:

- `npm run build` builds the Vite app
- `npm run preview` previews the production build
- `npm run lint` runs ESLint
- `npm run test` runs the autofill test file



