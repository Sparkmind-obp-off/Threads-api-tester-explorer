# Threads API — App Review Execution Plan

## Goal

Move from a technically live Threads API test explorer to a Meta app that can be submitted for review and, after Meta approval, used by real app users within the permissions Meta approves.

## Important distinction

The Cloudflare website is already deployed. The remaining gate is Meta-side authorization/review. This cannot be completed by GitHub or Cloudflare alone because Meta requires an authorized Meta/Threads user and, for permissions that require review, a submission from the app owner in Meta's developer dashboard.

## Current technical state

- Production site: https://threads-api-test-explorer.pages.dev/
- Backend health: PASS
- Configuration readiness: PASS when `THREADS_APP_ID`, `THREADS_APP_SECRET`, and `THREADS_REDIRECT_URI` are configured in Cloudflare
- OAuth security preflight: PASS
- Source graph host: `graph.threads.net`
- No app secret or access token is committed to the repository

## Exact execution path

### A. One-time Meta Dashboard setup

1. Open the Meta Developer dashboard for the Threads app.
2. Confirm the app has the **Threads** use case/product enabled.
3. Add the production OAuth redirect URI exactly as configured for the deployed explorer.
4. Confirm the Threads App ID and App Secret are available.
5. Configure the required app information/privacy details that Meta asks for before review.

### B. Configure Cloudflare

Set these as server-side secrets/environment variables for the production Pages project:

- `THREADS_APP_ID`
- `THREADS_APP_SECRET`
- `THREADS_REDIRECT_URI`

Optional:

- `OAUTH_SESSION_KEY`

Never put these values in the frontend bundle, GitHub repository, screenshots, or review description.

### C. Real OAuth validation

Use a Meta/Threads account that is eligible to test the app.

1. Open the production explorer.
2. Start **Connect Threads**.
3. Complete the Threads authorization screen.
4. Return to the explorer.
5. Confirm the session is authenticated.
6. Run `GET /me`.
7. Run `GET /me/threads`.
8. Confirm the token's granted permissions using Meta's token debugging flow if needed.

The Meta Threads API documentation confirms OAuth authorization is required and that `threads_basic` is sufficient for token exchange/refresh; additional capabilities require their corresponding permissions. See Meta's official Threads API documentation/collection for the current permission set.

### D. App Review

Do **not** request every permission just because it exists. Request only the permissions required by the first real product capability.

For the first automation product, the likely review scope should be based on the exact features we actually demonstrate, for example publishing if the product needs to publish Threads content. If reply management, insights, or other capabilities are added later, request those permissions separately when justified.

Prepare:

- clear product description
- exact use case for each requested permission
- test instructions
- reviewer account/test path where Meta requires one
- short screencast showing the end-to-end user flow
- privacy/data handling explanation
- public privacy policy URL if required by the app configuration/review form

### E. After approval

The explorer becomes the validation/lab tool. The real product should be a separate product layer using the same official Threads API capabilities.

Initial product direction:

`Connect Threads → authorize → create content → schedule/approve → publish → monitor`

Possible later capabilities depend on Meta's currently approved API permissions and endpoints. Do not promise access to private groups, arbitrary private data, or capabilities that the official Threads API does not expose.

## Hard blocker that cannot be automated here

No GitHub/Cloudflare operation can submit or approve Meta App Review on behalf of the app owner. The final Meta-side authorization/review action must be performed in the Meta Developer dashboard by an account with access to the app.

Everything before that gate can be validated and maintained in this repository.
