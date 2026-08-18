# Re-phrase

A [bb](https://getbb.app) plugin that adds a **Re-phrase** button to the prompt
input. Click it and the draft you already typed is sent to an agent with the
instruction to rewrite it; the improved prompt comes straight back into the
composer.

- Works in every composer: a thread, a queued message, a side chat and the new
  thread screen.
- Uses the agent selected in that prompt input, so a re-phrase runs on the model
  you were already about to use. A different default agent can be set in the
  plugin settings.
- The instruction sent with your draft is a setting too — rewrite it to match how
  you like prompts written.
- Nothing is sent anywhere your agent does not already go: the rewrite runs
  through bb, in a hidden thread that is stopped and deleted right after it
  answers.

## Install

```sh
bb plugin install https://github.com/suiramdev/bb-plugin-rephrase
```

Or pin a release range and let `bb plugin update` follow it:

```sh
bb plugin install git:https://github.com/suiramdev/bb-plugin-rephrase.git@^0.1.0
```

## Use it

Type a prompt, click the sparkle button next to the send button, and the draft is
replaced by the rewritten version. The composer is locked and dimmed while the
agent works — a rewrite usually takes a few seconds.

The toast that confirms the rewrite carries an **Undo** action that puts your
original text back.

The same command is in the composer's `+` menu, which is also where to find it in
the compact layout that has no room for action buttons.

## Settings

Extensions → Plugins → Re-phrase (or `bb plugin config rephrase`):

| Setting                 | Default            | What it does                                                                                                                                                       |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent**               | `composer`         | Which agent rewrites prompts. `composer` uses the agent selected in the prompt input you clicked from; any other value pins one provider for every re-phrase.        |
| **Model**               | empty              | Model for the pinned agent above. Empty means that agent's default model. Ignored while Agent is `composer`.                                                         |
| **Re-phrase instruction** | the built-in one | The instruction sent to the agent together with your draft. Clear it to restore the built-in instruction.                                                            |
| **Timeout**             | 2 minutes          | How long to wait for the agent before giving up.                                                                                                                    |

Settings are read per request, so a change applies to the next click — no reload
needed.

## How it works

`app.tsx` registers a composer action through `app.composer.customize`. Clicking
it posts the draft and its composer scope to the `rephrase` RPC method.

`server.ts` resolves which agent to use — the thread's own provider and model for
a thread-backed draft, the project's execution defaults on the new thread
screen, or the configured override — then spawns a **hidden** thread with your
instruction and the draft, waits for the turn to complete, and returns the
answer. The hidden thread runs in the most restrictive permission mode its
provider supports, reuses an environment the project already has rather than
provisioning a worktree, and is stopped and deleted on every path, including
errors and timeouts.

## Development

```sh
npm install
npm test          # vitest: composer action behavior + output cleanup
npm run typecheck
bb plugin install .
bb plugin dev     # rebuild + reload on every save
```

`bb plugin logs rephrase -f` follows the plugin's own log.

## License

MIT
