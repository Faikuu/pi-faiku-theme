# pi-faiku-theme

A pi package that makes pi look like [opencode](https://opencode.ai): opencode's default
dark palette, an ASCII input box with everything pi knows about the session on it, and a
notification in the top-right corner whenever you copy or paste text.

```
  🧠 claude-sonnet-4-5  🔀 anthropic  🔁 thinking medium  🧮 12% · 18.4k  🔢 ↑4.2k ↓980  💲 $0.42
╭────────────────────────────────────────────────────────────────────────────────────────╮
│                                                                                        │
│  ❯  Ask anything…                                                                      │
│                                                                                        │
╰────────────────────────────────────────────────────────────────────────────────────────╯
  📁 code/pi-faiku-theme  🌿 feat/theme  ✚2 ＋1  ⏱ 4m12s              ⏎ send  ⇧⏎ newline  ⌃c copy
```

While the agent is working the frame turns amber and the top rule says so:

```
╭─ ⏳ working ─────────────────────────────────────────────────────────────────────────────╮
```

And a clipboard round trip is never silent:

```
┌──────────────────────────┐          ┌──────────────────────────┐
│ 📋  Copied      142 chars │          │ 📥  Pasted    1 284 chars │
└──────────────────────────┘          └──────────────────────────┘
```

Arrow up already walks back through the prompts you have sent. Now you can see
where you are: a panel opens above the box, one row per prompt, newest at the
bottom, the one you are on marked with the input's own `❯`.

```
┌─ history ──────────────────────────────────────────────────┐
│   add a toast when a file is written                       │
│   why is the editor two rows short after a theme change?   │
│ ❯ refactor the parser into lib/parse.ts                    │
└─ ↵ restore · esc cancel ───────────────────────────────────┘
```

`↑` and `↓` move the marker, `↵` puts the prompt back in the input without
sending it, and `esc` gives back whatever you were typing before you opened the
panel.

And the transcript arrives folded: thinking runs hidden, tool output collapsed,
even the blocks still streaming. `ctrl+t` and `ctrl+o` expand them as they always
did, or `/faiku blocks` picks the group for you.

## Install

```bash
pi install npm:@faiku/pi-faiku-theme
```

Or try it for one session without installing:

```bash
pi -e npm:@faiku/pi-faiku-theme
```

From a clone:

```bash
pi install ./pi-faiku-theme
pi -e ./pi-faiku-theme
```

Restart pi, or run `/reload`. The package ships two resources: the `faiku` theme
(`themes/faiku.json`) and the extension that draws the box (`index.ts`). The extension selects
the theme for you at session start, unless you have already chosen a theme of your own —
`/faiku theme on` takes it back, and `/faiku theme off` puts the old one back.

## What the box shows

Each fact has an emoji that names it, and the rails drop the least important facts first as
the terminal narrows, so nothing is ever truncated mid-word.

| Emoji | Fact |
|---|---|
| 🧠 | active model |
| 🔀 | provider |
| 🔁 | thinking level, when it is above `off` |
| 🧮 | context window used, and the tokens in it |
| 🔢 | session input and output tokens |
| 💲 | session cost, when a model priced it |
| ⏱ | time the agent has spent working, not time since the session started |
| 📁 | working directory, last two segments |
| 🌿 | git branch |
| ✚ / ＋ | changed and untracked files |
| ❯ | the prompt |
| ⏳ | the agent is working |

Toasts use 📋 for a copy, 📥 for a paste, 🖼️ for a pasted image, ⚠️ and ❌ for warnings and
errors.

## Commands

```
/faiku                 show the configuration and the session at a glance
/faiku on|off          master switch for the box, the toasts and the theme
/faiku box on|off      the framed input box
/faiku toasts on|off   the top-right notifications
/faiku theme on|off    apply the faiku theme on session start
/faiku header on|off   the fact line above the box
/faiku rail on|off     the line below the box
/faiku git on|off      changed and untracked file counts
/faiku elapsed on|off  how long the agent has been working
/faiku history on|off  the prompt history panel above the box
/faiku collapse <mode> all | thinking | tools | off
/faiku blocks          pick a collapsed block to expand
/faiku padding <mode>  comfortable | compact
/faiku placeholder <s> the empty-input text
/faiku demo            draw the box and fire a toast
```

## Collapsed blocks

The transcript starts folded. Thinking runs are hidden and tool output is collapsed, including
the blocks that arrive mid-stream, so a long turn stays short while it happens.

Folding is pi's own, not a second renderer: tool output goes through `ui.setToolsExpanded()`,
and thinking is toggled through the `app.thinking.toggle` handler pi gives the editor, which is
the same `ctrl+t` you would press. Nothing about `ctrl+t`, `ctrl+o`, or clicking a thinking run
in fullscreen mode changes.

`/faiku blocks` counts what the branch actually holds and offers only what is collapsed right
now:

```
Collapsed blocks
❯ thinking       3 blocks · collapsed
  tool output   12 calls · collapsed
  everything    expand
  collapse all again
```

Two things worth knowing. Thinking can only be toggled through pi's handler, which lives on the
editor, so folding thinking needs the box mounted — with `/faiku box off` the mode still folds
tool output, and `/faiku info` says what it could not do. And because the toggle is pi's own,
pi persists the value it left behind, so a collapsed transcript stays collapsed in pi without
this package until `/faiku collapse off`, `/faiku off` or `ctrl+t` puts it back.

## Settings

Everything the commands do is written to `~/.pi/agent/settings.json` under `faiku`, so it
survives a restart:

```json
{
  "faiku": {
    "enabled": true,
    "box": true,
    "toasts": true,
    "applyTheme": true,
    "header": true,
    "hintRail": true,
    "gitStatus": true,
    "elapsed": true,
    "history": true,
    "collapse": "all",
    "padding": "comfortable",
    "placeholder": "Ask anything…",
    "toastTtlMs": 2500,
    "toastWidth": 30,
    "historyMaxVisible": 6
  }
}
```

## How it works

The box is a reframe, not a reimplementation. `FaikuEditor` extends pi's own `CustomEditor`,
asks it to lay the prompt out, and then wraps what comes back: the base's top rule becomes a
titled top border, its text rows gain vertical rules, and its autocomplete list moves inside
the frame. Word wrap, scrolling, the hardware cursor pi needs for IME placement, history,
kill-ring, undo and every app keybinding keep working exactly as they do without the package,
because they are the base's code.

The history panel is the same bargain. Arrow up is handed to the base, which owns the index,
the draft and the undo snapshot; the panel only records which entry the base landed on and
draws it. That is why it opens on pi's terms — a half-typed prompt with the cursor at the end
still moves the cursor, exactly as it always did — and why the panel and the walk can never
disagree. `lib/history.ts` holds a mirror of the base's list with the same trimming, the same
refusal to record the same prompt twice in a row and the same hundred-entry cap, and the
editor keeps the two in step by recording every prompt pi records.

Copy and paste are detected where they happen, in the editor's `handleInput`: a bracketed
paste is read before it is handed on, so the toast can report the real size of what arrived
even when pi collapses a large paste into a `[paste #1 +120 lines]` marker. A copy reads the
clipboard a moment later and reports the number of characters. Both toasts are non-capturing
overlays, so they never take a keystroke.

Enter on a directory in the `@` picker opens that directory instead of closing the list, so
picking your way into a folder is one keystroke per level rather than one per level plus a
reopen. Tab does the same. pi still does the inserting — the key is handed to the base, and
the list is only asked for again once the text names the directory, which scopes it to what is
inside. Escape still closes the list and leaves the path in the input, and a file still closes
it as before. Only `@` is treated this way: a slash command's arguments and an ordinary path
keep pi's rule, where accepting a directory is a step on the way to a file.

Layout is measured in terminal columns, never in string length, and every row is built for
the width it was handed — which is what makes the frame hold together next to emoji and CJK
text, at any terminal width down to 24 columns. Below that, pi's own editor is left alone
rather than drawn as a box too small to be a box.

| Module | Responsibility |
|---|---|
| `lib/palette.ts` | opencode's palette, painting, ANSI stripping |
| `lib/box.ts` | border and row geometry, as paintable parts |
| `lib/frame.ts` | taking pi's editor output apart and reading its labels |
| `lib/hud.ts` | the header and hint rail: segments, priorities, fitting |
| `lib/info.ts` | the session snapshot the rails report |
| `lib/clock.ts` | the timer: a stopwatch that runs only while the agent works |
| `lib/git.ts` | branch from `.git/HEAD`, dirty counts from a cached `git status` |
| `lib/editor.ts` | the framed editor, the history panel, the clipboard events, the `@` picker |
| `lib/history.ts` | the prompt history and the panel drawn above the box |
| `lib/toast.ts` | the toast store and its renderer |
| `lib/config.ts`, `lib/settings.ts` | configuration and `settings.json` |
| `lib/collapse.ts` | which blocks start folded, and the picker that unfolds them |

## Development

```bash
npm install
npm test        # node --test, with types stripped
npm run typecheck
```

## License

MIT © Faiku
