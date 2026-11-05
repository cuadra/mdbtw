# mdreader

A fast Markdown reader for Linux, driven entirely by vim keys. Written in Rust on
GTK4 + WebKitGTK.

```sh
mdreader README.md          # open a file
mdreader ~/notes            # open a directory's README.md
cat notes.md | mdreader -   # read from stdin
mdreader -e out.html doc.md # export a standalone HTML page
```

The file reloads by itself when it changes on disk, keeping your position.

## Install

Needs `gtk4`, `webkitgtk-6.0` and a Rust toolchain
(`sudo pacman -S --needed gtk4 webkitgtk-6.0 rust`).

For your user only, no root (installs to `~/.local/bin`, plus a desktop entry):

```sh
./install.sh
```

`./install.sh --uninstall` removes it. Or build a local pacman package from this
checkout, so pacman tracks the files:

```sh
cd packaging/arch
makepkg -si
```

Optional packages: `wl-clipboard` (yanks survive closing the reader), `gst-libav`
(MP4/H.264 video), `noto-fonts-emoji`, `otf-latinmodern-math`.

## Keys

Press `g?` in the reader for this list.

| Keys | Action |
| :--- | :--- |
| `j` `k` | Scroll down / up (counts work: `5j`) |
| `d` `u`, `Ctrl-d` `Ctrl-u` | Half page |
| `Ctrl-f` `Ctrl-b`, `Space` | Full page |
| `gg` `G` | Top / bottom |
| `{n}G`, `:{n}` | Go to source line *n* |
| `{n}%` | Go to *n* percent |
| `]]` `[[` | Next / previous heading |
| `}` `{` | Next / previous block |
| `gO`, `t` | Outline |
| `Ctrl-o` `Ctrl-i` | Back / forward through jumps and opened files |
| `H` `L` | Previous / next file |
| `m{a-z}` `'{a-z}` `''` | Marks |
| `/` `?` `n` `N` | Search (smartcase, live), next / previous match |
| `f` | Link hints: type the label to open a link, play a video, toggle `<details>` |
| `yf` | Link hints: copy the URL |
| `v` `V` | Visual / line-visual mode, then `h j k l w b e 0 $ { } gg G`, `o`, `y` to yank |
| `y` | Yank a mouse selection |
| `yc` | Hint code blocks and copy one |
| `yy` `yp` | Copy the markdown source / the file path |
| `+` `-` `=` | Zoom |
| `gt`, `:theme auto\|dark\|light` | Theme |
| `r`, `:e {file}` | Reload, open another file |
| `q`, `ZZ`, `:q` | Quit |

Links to other Markdown files open in the reader; everything else goes to the
default application. The mouse works too: click links, drag to select.

## What it renders

CommonMark and GitHub Flavored Markdown (tables, task lists, strikethrough,
autolinks, footnotes, alerts), plus description lists, wiki links, `==highlight==`,
`++insert++`, sub/superscript, spoilers, emoji shortcodes and front matter.

- **Code**: syntax highlighting for a few hundred languages.
- **Math**: `$inline$`, `$$display$$` and ` ```math ` blocks, rendered as MathML.
- **Diagrams**: ` ```mermaid ` blocks. Mermaid is fetched from jsDelivr the first
  time a document needs it; put a copy at
  `~/.local/share/mdreader/mermaid.min.js` to stay offline.
- **Images**: local and remote, with captions from the title.
- **Video and audio**: `![](clip.webm)` or raw `<video>` / `<audio>` tags play
  inline. Formats depend on the installed GStreamer plugins.
- **Raw HTML**: `<details>`, `<kbd>`, sized images and so on. Scripts inside a
  document never run.

Dark by default; `gt` switches to light. Theme and zoom are remembered in
`~/.config/mdreader/config`.

## Development

`examples/demo.md` exercises every feature. Debug builds can be scripted and
captured for testing; see `debug_hooks` in `src/main.rs`.
