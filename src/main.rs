mod render;

use std::cell::RefCell;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;
use std::time::Duration;

use webkit6::prelude::*;
use webkit6::{
    NavigationPolicyDecision, NavigationType, PolicyDecisionType, ResponsePolicyDecision,
    Settings, UserContentManager, WebContext, WebView, gdk, gio, glib, gtk,
};

use render::{PageOpts, Renderer};

const APP_ID: &str = "io.github.mdreader";
const MARKDOWN_EXT: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdx", "mdwn"];
const ZOOM_STEP: f64 = 1.1;

const USAGE: &str = "\
mdreader - a fast, vim-driven Markdown reader

Usage: mdreader [OPTIONS] <FILE | DIR | ->

  FILE   Markdown file to read
  DIR    Opens DIR/README.md
  -      Read markdown from stdin

Options:
  -e, --export <OUT.html>          Write a standalone HTML page and exit
  -t, --theme <auto|dark|light>    Theme for this run
  -h, --help                       Show this help
  -V, --version                    Show the version

Press g? inside the reader for the key bindings.";

// ------------------------------------------------------------------ config

struct Config {
    theme: String,
    zoom: f64,
}

impl Config {
    fn path() -> PathBuf {
        glib::user_config_dir().join("mdreader").join("config")
    }

    fn load() -> Self {
        let mut config = Config {
            theme: "dark".into(),
            zoom: 1.0,
        };
        let text = std::fs::read_to_string(Self::path()).unwrap_or_default();
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            match (key.trim(), value.trim()) {
                ("theme", v) if is_theme(v) => config.theme = v.into(),
                ("zoom", v) => config.zoom = v.parse().map(clamp_zoom).unwrap_or(1.0),
                _ => {}
            }
        }
        config
    }

    fn save(&self) {
        let path = Self::path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, format!("theme={}\nzoom={:.3}\n", self.theme, self.zoom));
    }
}

fn is_theme(value: &str) -> bool {
    matches!(value, "auto" | "dark" | "light")
}

fn clamp_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() {
        zoom.clamp(0.3, 5.0)
    } else {
        1.0
    }
}

// ------------------------------------------------------------------ documents

/// What is on screen: a file (re-read on reload) or text piped in on stdin.
#[derive(Clone)]
struct Doc {
    path: Option<PathBuf>,
    source: Rc<str>,
}

impl Doc {
    fn name(&self) -> String {
        match &self.path {
            Some(path) => path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string()),
            None => "[stdin]".into(),
        }
    }

    /// Base URI of the page; relative links and images resolve against it.
    fn uri(&self) -> String {
        match &self.path {
            Some(path) => gio::File::for_path(path).uri().to_string(),
            None => {
                let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
                format!("{}/", gio::File::for_path(cwd).uri().trim_end_matches('/'))
            }
        }
    }
}

struct Entry {
    doc: Doc,
    scroll: f64,
}

fn read_markdown(path: &Path) -> Result<Rc<str>, String> {
    std::fs::read(path)
        .map(|bytes| Rc::from(String::from_utf8_lossy(&bytes).as_ref()))
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn file_stamp(path: &Path) -> Option<(std::time::SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MARKDOWN_EXT.contains(&e.to_ascii_lowercase().as_str()))
}

/// Resolves a path the user typed or passed: a directory means its README.
fn resolve_input(path: &Path) -> PathBuf {
    let path = if path.is_dir() {
        ["README.md", "readme.md", "README.markdown", "index.md"]
            .iter()
            .map(|name| path.join(name))
            .find(|p| p.is_file())
            .unwrap_or_else(|| path.join("README.md"))
    } else {
        path.to_path_buf()
    };
    std::path::absolute(&path).unwrap_or(path)
}

/// Hands text to `wl-copy`, which keeps serving it after the reader exits.
/// A Wayland selection otherwise dies with the window that owns it, so
/// "yank, quit, paste" would paste nothing. Returns false if unavailable.
fn wl_copy(text: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};

    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return false;
    }
    let Ok(mut child) = Command::new("wl-copy")
        .args(["--type", "text/plain"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let written = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(text.as_bytes()).is_ok());
    // wl-copy forks into the background once it owns the selection, so this
    // only waits for the short-lived parent.
    child.wait().is_ok_and(|status| status.success()) && written
}

fn mermaid_url() -> String {
    // A local copy keeps diagrams working offline; otherwise use the CDN.
    [
        glib::user_data_dir().join("mdreader/mermaid.min.js"),
        PathBuf::from("/usr/share/mdreader/mermaid.min.js"),
    ]
    .iter()
    .find(|p| p.is_file())
    .map(|p| gio::File::for_path(p).uri().to_string())
    .unwrap_or_else(|| render::MERMAID_CDN.to_string())
}

// ------------------------------------------------------------------ app

struct State {
    doc: Option<Doc>,
    scroll: f64,
    back: Vec<Entry>,
    forward: Vec<Entry>,
    config: Config,
    monitor: Option<gio::FileMonitor>,
    /// mtime and size of the file as last seen by `poll`.
    stamp: Option<(std::time::SystemTime, u64)>,
    reload_queued: bool,
}

struct App {
    window: gtk::ApplicationWindow,
    webview: WebView,
    renderer: Renderer,
    mermaid_url: String,
    state: RefCell<State>,
}

impl App {
    /// Renders `doc` and puts it on screen.
    fn show(self: &Rc<Self>, doc: Doc, scroll: f64, fragment: Option<&str>, notice: Option<&str>) {
        let name = doc.name();
        let uri = doc.uri();
        let theme = self.state.borrow().config.theme.clone();
        let page = self.renderer.page(
            &doc.source,
            &PageOpts {
                name: &name,
                theme: &theme,
                scroll,
                fragment,
                notice,
                mermaid_url: &self.mermaid_url,
            },
        );
        self.window
            .set_title(Some(&format!("{} - mdreader", page.title)));
        self.watch(doc.path.as_deref());
        {
            let mut st = self.state.borrow_mut();
            st.doc = Some(doc);
            st.scroll = scroll;
        }
        self.webview.load_html(&page.html, Some(&uri));
    }

    fn open_path(
        self: &Rc<Self>,
        path: &Path,
        scroll: f64,
        fragment: Option<&str>,
        notice: Option<&str>,
    ) -> Result<(), String> {
        let source = read_markdown(path)?;
        let doc = Doc {
            path: Some(path.to_path_buf()),
            source,
        };
        self.show(doc, scroll, fragment, notice);
        Ok(())
    }

    /// Opens another file, remembering the current one for C-o / H.
    fn navigate(self: &Rc<Self>, path: &Path, fragment: Option<&str>) {
        let previous = {
            let st = self.state.borrow();
            st.doc.clone().map(|doc| Entry {
                doc,
                scroll: st.scroll,
            })
        };
        match self.open_path(path, 0.0, fragment, None) {
            Ok(()) => {
                let mut st = self.state.borrow_mut();
                st.back.extend(previous);
                st.forward.clear();
            }
            Err(e) => self.flash(&e, true),
        }
    }

    fn history(self: &Rc<Self>, backward: bool) {
        let target = {
            let mut st = self.state.borrow_mut();
            let current = st.doc.clone().map(|doc| Entry {
                doc,
                scroll: st.scroll,
            });
            let State { back, forward, .. } = &mut *st;
            let (from, to) = if backward {
                (back, forward)
            } else {
                (forward, back)
            };
            let Some(target) = from.pop() else {
                drop(st);
                let which = if backward { "previous" } else { "next" };
                self.flash(&format!("No {which} file"), false);
                return;
            };
            to.extend(current);
            target
        };
        match &target.doc.path {
            Some(path) => {
                if let Err(e) = self.open_path(path, target.scroll, None, None) {
                    self.flash(&e, true);
                }
            }
            None => self.show(target.doc, target.scroll, None, None),
        }
    }

    /// Re-reads the current file. With `quiet`, an unchanged or unreadable
    /// file is left alone (used for file-watcher events).
    fn reload(self: &Rc<Self>, quiet: bool) {
        let (doc, scroll) = {
            let st = self.state.borrow();
            (st.doc.clone(), st.scroll)
        };
        let Some(Doc {
            path: Some(path),
            source: old,
        }) = doc
        else {
            return;
        };
        match read_markdown(&path) {
            Ok(source) if quiet && source == old => {}
            Ok(source) => {
                let doc = Doc {
                    path: Some(path),
                    source,
                };
                self.show(doc, scroll, None, Some("Reloaded"));
            }
            Err(e) if !quiet => self.flash(&e, true),
            Err(_) => {}
        }
    }

    /// Watches the current file so edits show up as they are saved.
    fn watch(self: &Rc<Self>, path: Option<&Path>) {
        // Watch what a symlink points at: that is the file an editor rewrites.
        let target = path.map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()));
        let monitor = target.as_deref().and_then(|path| {
            gio::File::for_path(path)
                .monitor_file(gio::FileMonitorFlags::NONE, gio::Cancellable::NONE)
                .ok()
        });
        if let Some(monitor) = &monitor {
            let weak = Rc::downgrade(self);
            monitor.connect_changed(move |_, _, _, event| {
                use gio::FileMonitorEvent as E;
                if matches!(
                    event,
                    E::Changed | E::ChangesDoneHint | E::Created | E::Renamed | E::MovedIn
                ) && let Some(app) = weak.upgrade()
                {
                    app.queue_reload();
                }
            });
        }
        let mut st = self.state.borrow_mut();
        st.stamp = path.and_then(file_stamp);
        st.monitor = monitor;
    }

    /// Backstop for the file monitor, which sees nothing on network mounts
    /// and some bind mounts: compare the file's mtime and size once a second.
    fn poll(self: &Rc<Self>) {
        let changed = {
            let mut st = self.state.borrow_mut();
            let stamp = st
                .doc
                .as_ref()
                .and_then(|d| d.path.as_deref())
                .and_then(file_stamp);
            // A missing file (mid-save, or deleted) keeps the last good render.
            let changed = stamp.is_some() && stamp != st.stamp;
            if changed {
                st.stamp = stamp;
            }
            changed
        };
        if changed {
            self.queue_reload();
        }
    }

    /// Schedules one quiet reload; editors emit a burst of events per save.
    fn queue_reload(self: &Rc<Self>) {
        if std::mem::replace(&mut self.state.borrow_mut().reload_queued, true) {
            return;
        }
        let weak = Rc::downgrade(self);
        glib::timeout_add_local_once(Duration::from_millis(120), move || {
            let Some(app) = weak.upgrade() else { return };
            app.state.borrow_mut().reload_queued = false;
            // Ask the page where it is so the reload lands on the same spot.
            app.webview.clone().evaluate_javascript(
                "window.scrollY",
                None,
                None,
                gio::Cancellable::NONE,
                move |result| {
                    if let Ok(y) = result.map(|v| v.to_double())
                        && y.is_finite()
                    {
                        app.state.borrow_mut().scroll = y;
                    }
                    app.reload(true);
                },
            );
        });
    }

    /// Routes a followed link: markdown files open here, everything else
    /// goes to the desktop's default handler.
    fn open_href(self: &Rc<Self>, href: &str) {
        let (base, fragment) = match href.split_once('#') {
            Some((base, fragment)) => (base, Some(fragment)),
            None => (href, None),
        };
        let scheme = base.split_once(':').map(|(s, _)| s.to_ascii_lowercase());
        match scheme.as_deref() {
            Some("file") => {
                let Some(path) = gio::File::for_uri(base).path() else {
                    return self.flash(&format!("Cannot open {base}"), true);
                };
                // Wiki links name a note without its extension.
                let with_md = PathBuf::from(format!("{}.md", path.display()));
                if path.is_file() && is_markdown(&path) {
                    self.navigate(&path, fragment);
                } else if path.is_dir() && resolve_input(&path).is_file() {
                    self.navigate(&resolve_input(&path), fragment);
                } else if !path.exists() && with_md.is_file() {
                    self.navigate(&with_md, fragment);
                } else if path.exists() {
                    self.launch(base);
                } else {
                    self.flash(&format!("Not found: {}", path.display()), true);
                }
            }
            Some("javascript" | "data" | "blob" | "about") | None => {}
            Some(_) => self.launch(href),
        }
    }

    fn launch(&self, uri: &str) {
        match gio::AppInfo::launch_default_for_uri(uri, gio::AppLaunchContext::NONE) {
            Ok(()) => self.flash(&format!("Opened {uri}"), false),
            Err(e) => self.flash(&format!("Cannot open {uri}: {e}"), true),
        }
    }

    fn flash(&self, message: &str, error: bool) {
        let script = format!(
            "window.mdr && window.mdr.flash({}, {error})",
            serde_json::Value::String(message.into())
        );
        self.webview
            .evaluate_javascript(&script, None, None, gio::Cancellable::NONE, |_| {});
    }

    fn copy(&self, text: &str) {
        if !wl_copy(text) {
            self.webview.clipboard().set_text(text);
        }
    }

    fn on_message(self: &Rc<Self>, text: &str) {
        // Only the page we rendered may drive the app.
        let expected = self.state.borrow().doc.as_ref().map(Doc::uri);
        if self.webview.uri().map(|u| u.to_string()) != expected {
            return;
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            return;
        };
        if let Some(y) = msg["y"].as_f64() {
            self.state.borrow_mut().scroll = y;
        }
        let field = |key: &str| msg[key].as_str().unwrap_or_default();
        match field("type") {
            "yank" => self.copy(field("text")),
            "yank-source" => {
                let source = self.state.borrow().doc.as_ref().map(|d| d.source.clone());
                self.copy(source.as_deref().unwrap_or_default());
            }
            "yank-path" => {
                let path = self.state.borrow().doc.as_ref().and_then(|d| d.path.clone());
                self.copy(&path.map(|p| p.display().to_string()).unwrap_or_default());
            }
            "open" => self.open_href(field("href")),
            "back" => self.history(true),
            "forward" => self.history(false),
            "reload" => self.reload(false),
            "edit" => self.edit(field("path")),
            "zoom" => {
                let zoom = match msg["dir"].as_i64().unwrap_or(0) {
                    0 => 1.0,
                    d if d > 0 => clamp_zoom(self.webview.zoom_level() * ZOOM_STEP),
                    _ => clamp_zoom(self.webview.zoom_level() / ZOOM_STEP),
                };
                self.webview.set_zoom_level(zoom);
                let mut st = self.state.borrow_mut();
                st.config.zoom = zoom;
                st.config.save();
                drop(st);
                self.flash(&format!("Zoom {:.0}%", zoom * 100.0), false);
            }
            "theme" if is_theme(field("value")) => {
                let mut st = self.state.borrow_mut();
                st.config.theme = field("value").into();
                st.config.save();
            }
            "quit" => self.window.close(),
            _ => {}
        }
    }

    /// `:e path` - relative paths resolve against the current file.
    fn edit(self: &Rc<Self>, typed: &str) {
        let mut path = match typed.strip_prefix("~/") {
            Some(rest) => glib::home_dir().join(rest),
            None => PathBuf::from(typed),
        };
        if path.is_relative() {
            let dir = self
                .state
                .borrow()
                .doc
                .as_ref()
                .and_then(|d| d.path.as_ref()?.parent().map(Path::to_path_buf));
            if let Some(dir) = dir {
                path = dir.join(path);
            }
        }
        self.navigate(&resolve_input(&path), None);
    }

    fn decide_policy(
        self: &Rc<Self>,
        decision: &webkit6::PolicyDecision,
        kind: PolicyDecisionType,
    ) -> bool {
        match kind {
            PolicyDecisionType::NavigationAction | PolicyDecisionType::NewWindowAction => {
                let Some(action) = decision
                    .downcast_ref::<NavigationPolicyDecision>()
                    .and_then(|d| d.navigation_action())
                else {
                    return false;
                };
                let uri = action
                    .request()
                    .and_then(|r| r.uri())
                    .map(|u| u.to_string())
                    .unwrap_or_default();
                let nav = action.navigation_type();
                // The page script handles links itself; this is the backstop
                // that keeps the view from ever navigating away from the document.
                if kind == PolicyDecisionType::NewWindowAction || nav == NavigationType::LinkClicked
                {
                    decision.ignore();
                    self.open_href(&uri);
                    return true;
                }
                match nav {
                    NavigationType::Reload => {
                        decision.ignore();
                        self.reload(false);
                        true
                    }
                    NavigationType::BackForward
                    | NavigationType::FormSubmitted
                    | NavigationType::FormResubmitted => {
                        decision.ignore();
                        true
                    }
                    _ => false,
                }
            }
            PolicyDecisionType::Response => {
                let Some(response) = decision.downcast_ref::<ResponsePolicyDecision>() else {
                    return false;
                };
                if !response.is_main_frame_main_resource() {
                    return false;
                }
                let uri = response.request().and_then(|r| r.uri()).map(|u| u.to_string());
                let expected = self.state.borrow().doc.as_ref().map(Doc::uri);
                if uri == expected || uri.as_deref().is_some_and(|u| u.starts_with("about:")) {
                    return false;
                }
                decision.ignore();
                true
            }
            _ => false,
        }
    }
}

fn build_ui(gtk_app: &gtk::Application, doc: Doc, config: Config) {
    let debug = std::env::var_os("MDREADER_DEBUG").is_some();

    // Local videos are read by the sandboxed web process, so the document's
    // directory has to be made visible (read-only) before that process starts.
    if let (Some(context), Some(dir)) = (
        WebContext::default(),
        doc.path.as_deref().and_then(Path::parent),
    ) {
        context.add_path_to_sandbox(dir, true);
    }

    let settings = Settings::new();
    settings.set_enable_smooth_scrolling(false);
    settings.set_enable_developer_extras(debug);
    settings.set_enable_write_console_messages_to_stdout(debug);

    let content_manager = UserContentManager::new();
    content_manager.register_script_message_handler("mdr", None);

    let webview = WebView::builder()
        .user_content_manager(&content_manager)
        .settings(&settings)
        .build();
    webview.set_zoom_level(config.zoom);

    let dark = match config.theme.as_str() {
        "dark" => true,
        "light" => false,
        _ => gtk::Settings::default().is_some_and(|s| s.is_gtk_application_prefer_dark_theme()),
    };
    let background = if dark { "#0d1117" } else { "#ffffff" };
    if let Ok(color) = gdk::RGBA::parse(background) {
        webview.set_background_color(&color);
    }

    let window = gtk::ApplicationWindow::builder()
        .application(gtk_app)
        .title("mdreader")
        .default_width(980)
        .default_height(1040)
        .child(&webview)
        .build();

    let app = Rc::new(App {
        window,
        webview,
        renderer: Renderer::new(),
        mermaid_url: mermaid_url(),
        state: RefCell::new(State {
            doc: None,
            scroll: 0.0,
            back: Vec::new(),
            forward: Vec::new(),
            config,
            monitor: None,
            stamp: None,
            reload_queued: false,
        }),
    });

    content_manager.connect_script_message_received(Some("mdr"), {
        let app = app.clone();
        move |_, value| app.on_message(&value.to_str())
    });
    app.webview.connect_decide_policy({
        let app = app.clone();
        move |_, decision, kind| app.decide_policy(decision, kind)
    });

    #[cfg(debug_assertions)]
    debug_hooks(&app);

    glib::timeout_add_seconds_local(1, {
        let weak = Rc::downgrade(&app);
        move || match weak.upgrade() {
            Some(app) => {
                app.poll();
                glib::ControlFlow::Continue
            }
            None => glib::ControlFlow::Break,
        }
    });

    app.show(doc, 0.0, None, None);
    app.window.present();
    app.webview.grab_focus();
}

/// Debug builds only: drive the reader from a script and capture what it drew.
///
/// - `MDREADER_DEBUG_SCRIPT=<file.js>` runs after every page load
/// - `MDREADER_DEBUG_SNAPSHOT=<file.png>` saves the view, then quits
/// - `MDREADER_DEBUG_FULL=1` snapshots the whole document, not just the viewport
/// - `MDREADER_DEBUG_DELAY=<ms>` waits this long before the snapshot (default 1500)
#[cfg(debug_assertions)]
fn debug_hooks(app: &Rc<App>) {
    use std::cell::Cell;
    use webkit6::{LoadEvent, SnapshotOptions, SnapshotRegion};

    let script = std::env::var("MDREADER_DEBUG_SCRIPT")
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok());
    let snapshot = std::env::var_os("MDREADER_DEBUG_SNAPSHOT").map(PathBuf::from);
    if script.is_none() && snapshot.is_none() {
        return;
    }
    let delay = std::env::var("MDREADER_DEBUG_DELAY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1500);
    let region = if std::env::var_os("MDREADER_DEBUG_FULL").is_some() {
        SnapshotRegion::FullDocument
    } else {
        SnapshotRegion::Visible
    };
    let armed = Cell::new(false);
    let window = app.window.clone();
    app.webview.connect_load_changed(move |webview, event| {
        if event != LoadEvent::Finished {
            return;
        }
        if let Some(script) = &script {
            webview.evaluate_javascript(script, None, None, gio::Cancellable::NONE, |result| {
                if let Err(e) = result {
                    eprintln!("debug script: {e}");
                }
            });
        }
        if armed.replace(true) {
            return;
        }
        let (webview, window, snapshot) = (webview.clone(), window.clone(), snapshot.clone());
        glib::timeout_add_local_once(Duration::from_millis(delay), move || {
            let Some(path) = snapshot else {
                return window.close();
            };
            webview.snapshot(
                region,
                SnapshotOptions::INCLUDE_SELECTION_HIGHLIGHTING,
                gio::Cancellable::NONE,
                move |texture| {
                    match texture.map(|t| t.save_to_png(&path)) {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => eprintln!("debug snapshot: {e}"),
                        Err(e) => eprintln!("debug snapshot: {e}"),
                    }
                    window.close();
                },
            );
        });
    });
}

// ------------------------------------------------------------------ entry

struct Args {
    input: String,
    export: Option<PathBuf>,
    theme: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut input = None;
    let mut export = None;
    let mut theme = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("mdreader {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "-e" | "--export" => {
                export = Some(PathBuf::from(
                    args.next().ok_or("--export needs an output path")?,
                ));
            }
            "-t" | "--theme" => {
                let value = args.next().ok_or("--theme needs a value")?;
                if !is_theme(&value) {
                    return Err(format!("unknown theme '{value}' (auto, dark or light)"));
                }
                theme = Some(value);
            }
            "-" => input = Some(arg),
            flag if flag.starts_with('-') => return Err(format!("unknown option '{flag}'")),
            _ if input.is_some() => return Err("only one file can be opened".into()),
            _ => input = Some(arg),
        }
    }
    Ok(Args {
        input: input.ok_or("no file given")?,
        export,
        theme,
    })
}

fn load_input(input: &str) -> Result<Doc, String> {
    if input == "-" {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|e| format!("stdin: {e}"))?;
        return Ok(Doc {
            path: None,
            source: Rc::from(text),
        });
    }
    let path = resolve_input(Path::new(input));
    let source = read_markdown(&path)?;
    Ok(Doc {
        path: Some(path),
        source,
    })
}

fn main() -> ExitCode {
    let (args, doc) = match parse_args().and_then(|args| {
        let doc = load_input(&args.input)?;
        Ok((args, doc))
    }) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("mdreader: {e}\nTry 'mdreader --help' for usage.");
            return ExitCode::from(2);
        }
    };

    let mut config = Config::load();
    if let Some(theme) = args.theme {
        config.theme = theme;
    }

    if let Some(out) = args.export {
        let name = doc.name();
        let page = Renderer::new().page(
            &doc.source,
            &PageOpts {
                name: &name,
                theme: &config.theme,
                mermaid_url: render::MERMAID_CDN,
                ..Default::default()
            },
        );
        return match std::fs::write(&out, page.html) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("mdreader: {}: {e}", out.display());
                ExitCode::FAILURE
            }
        };
    }

    let gtk_app = gtk::Application::builder()
        .application_id(APP_ID)
        .flags(gio::ApplicationFlags::NON_UNIQUE)
        .build();
    let startup = RefCell::new(Some((doc, config)));
    gtk_app.connect_activate(move |gtk_app| {
        if let Some((doc, config)) = startup.borrow_mut().take() {
            build_ui(gtk_app, doc, config);
        }
    });
    let code = gtk_app.run_with_args::<&str>(&[]);
    ExitCode::from(code.get())
}
