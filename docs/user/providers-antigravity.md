# Antigravity

T3 Code runs Google's Antigravity CLI (`agy`, version 1.5.0 or newer) on your selected
environment. Google controls which models and account access are available through it.

## Set up Antigravity

Install the Antigravity CLI on the environment that runs your project (see
[antigravity.google](https://antigravity.google)). T3 Code does not install it. Then open **Settings >
Providers**, choose that environment, and enable Antigravity. Choose **Sign in** and complete the
browser sign-in, or run `agy` in a terminal on the environment and sign in there. Wait for T3 Code
to confirm account access and load models before starting a thread. You can also sign in from
**Settings > Providers** in the mobile app.

If T3 Code cannot find `agy`, set **Binary path** in the provider settings. Setup requires
permission to operate the environment.

### Sign in from a remote device

Google returns to a `localhost` address. It can finish directly when your browser is
on the environment's machine. From another device, the final page will usually
fail to load because the sign-in listener is on the environment.

Copy the full return address, including everything after `?`, into the return URL
field in the client where you started sign-in, then choose
**Continue**. Keep the original address; do not replace it with the server's
hostname. Only that T3 Code sign-in session can finish the attempt. If it expires,
retry sign-in and use the new link.

The return URL contains a temporary sign-in code. Paste it only into the setup
field. A successful callback page alone does not confirm account access; wait for
T3 Code's confirmation.

### Other sign-in methods

Choose **Sign-in method** in the Antigravity provider settings:

| Method                     | Credentials                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Google account             | Personal Google sign-in in the browser                                                       |
| Gemini Enterprise          | Browser sign-in, GCP project, and GCP location                                               |
| Gemini API key             | API key; choose Connect without a browser                                                    |
| Agent Platform / Vertex AI | API key, or GCP project and location with Application Default Credentials on the environment |

The environment stores the Antigravity API key outside its settings file, and
clients only see whether one is saved. The agent uses the method and credentials selected for this instance; with
Gemini API key, the saved key is passed to `agy` as `GEMINI_API_KEY`.
Changing the method stops the instance's sessions. Sign out before replacing an
account.

## Models and threads

The model list comes from your Antigravity account: Gemini 4 Argon and Gemini 3.8 Flash, plus
Claude and GPT models when your account offers them. Pick a thinking level beside the model list
in the model picker; it shows only the levels the selected model supports. A resumed thread keeps
its selected model. If access to that model ends, select another available model before continuing.

Use Antigravity's native `/plan` command for planning. Tool approvals follow [Permission modes](./permission-modes.md).
Questions with fixed choices still need one of the offered answers, even in
**Full access**.

Reverting a turn restores your files and rewinds Antigravity's conversation, so later turns do not
remember what you reverted. This works on `agy` versions T3 Code has tested. On other versions the
files are still restored, but the next turn starts a fresh agent session without the earlier
conversation.

Manual context compaction is unavailable through Antigravity's ACP mode, even though its CLI has
`/compact`. Send `/clear` when you need a fresh context.

Antigravity creates empty `.gemini/skills` and `.agents/skills` folders in the workspace when a
session starts. Git does not track empty folders, so they never appear in commits.

### Skills and attachments

Put project skills in `.agents/skills`. T3 Code also reads `.gemini/skills` and the legacy
`.agent/skills` directory. Among these project locations, the first copy wins in this order:
`.gemini/skills`, `.agents/skills`, `.agent/skills`. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

Skills for every project go in `~/.gemini/config/skills` or `~/.gemini/antigravity-cli/skills`.
Antigravity does not read `~/.agents/skills`, so a skill there only appears when the project itself
is your home directory.

Antigravity reads attached files, including images, directly from disk.

### Subagents

Antigravity groups subagent activity into batches. Open a batch and select **Subagent work**
(**Work** on mobile) to read each child's role, prompt, and recent steps. This view is read only:
you cannot message or control individual subagents, and an idle batch does not confirm that every
child succeeded. If Antigravity did not record which children a batch started, the view says so.
See [agent work](./thread-sidebar.md#inspect-agent-work) for where to inspect activity.

## Accounts and updates

By default Antigravity shares its sign-in and conversations with the `agy` CLI in `~/.gemini`.
Signing out in T3 Code then signs the CLI out too.

To use another Google account, add an Antigravity provider instance in **Settings > Providers** on
web or desktop and set its **Gemini directory** to a folder inside your home directory, for example
`~/.gemini-work`. That instance has its own sign-in and conversations.

| Action   | Effect                                                            |
| -------- | ----------------------------------------------------------------- |
| Disable  | Stops the instance's sessions and keeps its Google sign-in.       |
| Sign out | Stops the instance's sessions and removes its saved Google login. |

Both keep thread history and workspace files. Sending `/logout` by itself in a thread signs out
its instance, including stopping that instance's other sessions. Sign out, then sign in again to
replace an account.

When a newer `agy` is available, **Update now** on the provider card runs `agy update`. You can
also run it yourself in a terminal.

## Check access and troubleshoot

Open **Usage > Limits** to see the remaining Gemini and shared Claude/GPT allowances
for Google sign-ins. Each group has separate five-hour and weekly limits and reset
times. Limits refresh with provider status and include usage outside T3 Code.

A server restart keeps your Google sign-in. The provider shows the saved account
until a session, a refresh, or a sign-out reports something new.

To check access and reload models, use **Refresh provider status** in web or desktop
provider settings, or **Refresh models** in mobile thread settings. If asked to
sign in again, use provider settings on web or desktop, or **Settings > Providers** on mobile.

Threads started before Antigravity moved to the `agy` CLI keep working. Their next message
starts a new `agy` conversation with the earlier conversation handed over.

If Google reports `SUBSCRIPTION_REQUIRED`, an account restriction, or a usage limit,
follow the provider's message and any retry time. See [Google's account plans][plans]
for eligibility.

[plans]: https://antigravity.google/docs/plans
