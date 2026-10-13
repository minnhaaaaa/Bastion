# GitHub OAuth setup

Register a GitHub OAuth app under **Settings → Developer settings → OAuth Apps**. Set its homepage to your Bastion web URL and its authorization callback to the controller's externally reachable `/auth/github/callback` URL. Local development may use a loopback HTTP callback; deployed controllers require HTTPS.

Configure these controller environment variables (never `VITE_*` variables):

- `GITHUB_OAUTH_CONFIG`: a JSON object containing `clientId`, `authorizeUrl`, `tokenUrl`, `userUrl`, `redirectUri`, `scope`, `timeoutMs`, `attemptTtlMs`, and `maxPending`.
- `GITHUB_OAUTH_CLIENT_SECRET`: the registered app's client secret.
- `PROVIDER_CREDENTIAL_KEY`: the existing persistent 32-byte encryption key encoded as hex. Back it up; changing it invalidates stored credentials.

For GitHub.com, set `authorizeUrl` to `https://github.com/login/oauth/authorize`, `tokenUrl` to `https://github.com/login/oauth/access_token`, and `userUrl` to `https://api.github.com/user`. Set `redirectUri` exactly to the callback registered with GitHub. Choose positive numeric timeout, attempt lifetime, and pending-attempt limits for your deployment. No endpoint or limit is supplied implicitly.

Use `public_repo` scope for public repository publishing. Use `repo` only if you intend to request private-repository access too. OAuth scopes apply to the account's accessible repositories, not just one selected repository. The existing repository importer still supports public cloning only.

Restart the controller, then open **Settings → Project repository → Connect GitHub**. This opens the GitHub permission window directly. If the browser blocks the popup, use **Continue on GitHub**. Authorize on GitHub, return to Bastion, and confirm the displayed account. If the status has not refreshed when returning, click **Check sign-in**.

The flow uses random single-use state, PKCE S256, bounded attempts, authenticated account confirmation, and encrypted owner-bound token storage. Tokens never enter browser responses, model inputs or run events. Callback routes suppress request logging and disable caching. Ensure any reverse proxy also excludes callback query strings from logs.

Disconnect deletes Bastion's stored credential and cancels pending sign-ins. To revoke GitHub's grant itself, remove the app under GitHub's authorized OAuth apps. Pending sign-ins do not survive controller restarts; start again after a restart.

Publishing is off by default. Select **Task options → Create a GitHub pull request after this task** to request it explicitly for a new protected run. For requested runs using a connected remote repository with edit access, the controller pins the repository connection at launch. After successful execution and passing recorded checks, it publishes only successful human-approved file writes as a pull request. GitHub credentials never go to the model. Publication stops if local files differ from the approved content or the upstream branch has advanced. After the response has finished displaying, the chat shows the requested PR link or a retryable failure. Ordinary tasks show no PR card. Existing runs are not retroactively published. Merging remains a GitHub action performed by the user.

References: [GitHub OAuth authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).
