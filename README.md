# pi-faiku-theme

A pi package that makes pi look like [opencode](https://opencode.ai): opencode's default
dark palette, an ASCII input box with everything pi knows about the session on it, a
notification in the top-right corner whenever you copy or paste text, and a row of sticky
session tabs across the top of the terminal.

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

pi keeps one session per process and no tabs, so this package puts a tab bar on the
top row: your most recent chats for this directory, the one you are in marked with
`❯`, and a `●` while the agent works. Click a tab to switch, middle-click to close it,
`alt+1`…`alt+9` to jump by number, `alt+0` for a new chat.

```
 ❯ why is the editor two r… ● │   refactor the parser │   add a toast when a fi…  + ──────
───────────────────────────────────────────────────────────────────────────────────────
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
/faiku history on|off  the prompt history panel above the box
/faiku tabs on|off     the session tab bar at the top of the terminal
/faiku tab <n>        switch to chat n on the bar
/faiku tab            list the chats on the bar
/faiku tab new        start a new chat
/faiku tab close <n>  hide chat n from the bar
/faiku tab reopen     bring back the last hidden chat
/faiku keys           listen for 5s and report what the terminal sent
/faiku keys list      the keys the tab bar answers to
/faiku keys set <slot> <key>  rebind a slot, e.g. 1 alt+1; `none` unbinds
/faiku keys reset     back to the default keys
/faiku fullscreen on|off  pi's TUI mode; the tab bar needs fullscreen
/faiku collapse <mode> all | thinking | tools | off
/faiku blocks          pick a collapsed block to expand
/faiku padding <mode>  comfortable | compact
/faiku placeholder <s> the empty-input text
/faiku demo            draw the box and fire a toast
```

## Session tabs

A tab is a pi session file for this working directory, newest first, up to `tabsMax` of them.
The bar is a second non-capturing overlay pinned to the top of the screen, so it stays put while
the transcript scrolls and never takes a keystroke — the editor keeps focus the whole time. It
is two rows: the tabs, and a rule in the same colour as the input box's frame, so the bar and
the conversation never read as one thing. Below 40 columns it hides itself rather than crowding
the conversation. Toasts move down by the same two rows while it is up.

**The mouse needs pi's fullscreen renderer.** pi's default *regular* mode has no mouse at all and
no fixed screen to pin a row to, so there the bar is not drawn rather than sitting there ignoring
clicks. Every other click in pi — a thinking block, a tool row — needs the same mode.

pi builds its renderer once at start and no extension API swaps it, so the package writes
`tuiMode: "fullscreen"` into pi's settings on the first session start in regular mode and says
what that means: **the bar and the mouse arrive on the next `pi`**. That restart is the one thing
this package cannot automate from inside a running pi — the renderer swap is pi's own private
code. It is also a one-time cost: the setting is remembered, so later starts need nothing.

For a machine that starts in regular mode, `pi --tui-mode fullscreen` skips the wait entirely,
which is worth a shell alias if you would rather not depend on a package having written to your
settings.

Two channels carry the news: a toast, which expires by itself like every other one, and a line
in pi's footer, which is still there when you come back to the window. The footer is used because
it is not an overlay, so a note in it never blocks pi's own live switches.

Every write this package makes to `settings.json` is atomic — new contents go to a temporary
file in the same directory and are renamed over the old one. That file is read by other
extensions while pi is still starting, and a truncate-then-write hands them an empty or
half-written file; a rename cannot be observed halfway. pi's own settings storage takes a
lockfile this package has no business reaching for, so the writes are not serialized against
pi's saves: a race we lose costs one field and nothing else.

To switch without restarting, run `/faiku fullscreen`, which also closes the toast stack (pi
refuses to swap its renderer while any overlay is open, and ours are the only ones in the way);
`/faiku toasts on` brings the notifications back inside the new renderer. `/faiku fullscreen off`
puts the mode back and remembers that you meant it, so the package will not ask again.

| | |
|---|---|
| left click | switch to that chat |
| middle or right click | close it, and remember that you did |
| `alt+1`…`alt+9` | switch to chat _n_ |
| `alt+0` | start a new chat |
| `alt+shift+←` / `alt+shift+→` | previous or next chat |

Every one of those keys is a default rather than a promise. A shortcut only fires if the bytes
arrive, and on macOS that is a terminal setting: `alt+1` is `esc` followed by `1`, which iTerm2,
Ghostty and a Terminal set to "Option sends Esc+" produce — and which a Terminal set to "nothing"
never sends at all.

So the bindings live in settings, not in code, and there is a command for finding the right one:

```
/faiku keys                       listen for 5s, then report what the keyboard sent
/faiku keys list                  the keys the bar answers to right now
/faiku keys set 1 ctrl+alt+1      rebind a slot; `none` unbinds it
/faiku keys reset                 back to the defaults
```

`/faiku keys` names each captured sequence the way pi names it, and says what it would run:

```
"\u001b1"  →  alt+1  →  chat 1
"\u001b"   →  escape  →  (nothing: pi needs escape to stop an agent)
```

If a key is missing from that report, the terminal is not sending it and the slot should be
rebound. A binding is read when pi starts, like every other setting here, so a rebind takes
effect on the next `pi` — `/faiku keys` says so when you make one, and `/faiku info` lists the
active keys with the rest of the configuration.

Two details are worth knowing. A switch needs pi's `ExtensionCommandContext`, which only a
command has, so a click dispatches the real `/faiku tab <n>` through pi's own command
expander rather than typing it: no flash in the input, nothing added to your prompt history,
and nothing sent to the model if the command is somehow not registered. And the chat you are
in always stays on the bar, even when it is old enough to fall off the end of the list — a bar
that hid where you are would be a lie. Switching and starting a new chat are refused while the
agent is working, because both replace the session underneath it.

Closed chats are remembered in `faiku.tabsClosed` and `/faiku tab reopen` brings the last one
back.

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
    "tabs": true,
    "fullscreen": true,
    "tabsMax": 8,
    "tabsClosed": [],
    "tabKeys": {},
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
| `lib/tabs.ts` | the session list behind the bar, its row and its hit regions |
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
