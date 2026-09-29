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
/faiku padding <mode>  comfortable | compact
/faiku placeholder <s> the empty-input text
/faiku demo            draw the box and fire a toast
```

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
    "padding": "comfortable",
    "placeholder": "Ask anything…",
    "toastTtlMs": 2500,
    "toastWidth": 30
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

Copy and paste are detected where they happen, in the editor's `handleInput`: a bracketed
paste is read before it is handed on, so the toast can report the real size of what arrived
even when pi collapses a large paste into a `[paste #1 +120 lines]` marker. A copy reads the
clipboard a moment later and reports the number of characters. Both toasts are non-capturing
overlays, so they never take a keystroke.

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
| `lib/editor.ts` | the framed editor and the clipboard events |
| `lib/toast.ts` | the toast store and its renderer |
| `lib/config.ts`, `lib/settings.ts` | configuration and `settings.json` |

## Development

```bash
npm install
npm test        # node --test, with types stripped
npm run typecheck
```

## License

MIT © Faiku
