//! Markdown -> self-contained HTML page.

use std::hash::{BuildHasher, Hasher};

use comrak::nodes::NodeValue;
use comrak::plugins::syntect::{SyntectAdapter, SyntectAdapterBuilder};
use comrak::{Arena, Node, Options, format_html_with_plugins, options::Plugins, parse_document};
use pulldown_latex::config::DisplayMode;
use pulldown_latex::{Parser as LatexParser, RenderConfig, Storage, push_mathml};
use syntect::highlighting::ThemeSet;
use syntect::html::{ClassStyle, css_for_theme_with_class_style};

const STYLE: &str = include_str!("../assets/style.css");
const SCRIPT: &str = include_str!("../assets/vim.js");

const HL_PREFIX: &str = "hl-";
const LIGHT_THEME: &str = "InspiredGitHub";
const DARK_THEME: &str = "base16-ocean.dark";

const VIDEO_EXT: &[&str] = &["mp4", "webm", "mkv", "mov", "m4v", "ogv", "avi"];
const AUDIO_EXT: &[&str] = &["mp3", "ogg", "oga", "wav", "flac", "m4a", "opus", "aac"];

pub const MERMAID_CDN: &str = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

/// Per-load parameters handed to the page script.
#[derive(Default)]
pub struct PageOpts<'a> {
    /// Shown in the status bar.
    pub name: &'a str,
    pub theme: &'a str,
    pub scroll: f64,
    pub fragment: Option<&'a str>,
    pub notice: Option<&'a str>,
    pub mermaid_url: &'a str,
}

pub struct Page {
    pub title: String,
    pub html: String,
}

pub struct Renderer {
    adapter: SyntectAdapter,
    highlight_css: String,
    options: Options<'static>,
}

impl Renderer {
    pub fn new() -> Self {
        let adapter = SyntectAdapterBuilder::new()
            .syntax_set(two_face::syntax::extra_newlines())
            .css_with_class_prefix(HL_PREFIX)
            .build();
        Renderer {
            adapter,
            highlight_css: highlight_css(),
            options: options(),
        }
    }

    pub fn page(&self, source: &str, opts: &PageOpts) -> Page {
        let arena = Arena::new();
        let root = parse_document(&arena, source, &self.options);
        transform(root);

        let title = first_heading(root).unwrap_or_else(|| opts.name.to_string());

        let mut plugins = Plugins::default();
        plugins.render.codefence_syntax_highlighter = Some(&self.adapter);
        let mut body = String::with_capacity(source.len() * 2);
        // Writing into a String cannot fail.
        let _ = format_html_with_plugins(root, &self.options, &mut body, &plugins);

        let nonce = nonce();
        let init = serde_json::json!({
            "name": opts.name,
            "theme": opts.theme,
            "scroll": opts.scroll,
            "fragment": opts.fragment,
            "notice": opts.notice,
            "mermaid": opts.mermaid_url,
        })
        .to_string()
        // Keep "</script>" or "<!--" in a file name from ending the script block.
        .replace('<', "\\u003c");

        let mut html = String::with_capacity(body.len() + STYLE.len() + SCRIPT.len() + 4096);
        html.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
        // Only our own scripts carry the nonce, so scripts and inline event
        // handlers inside the markdown never execute.
        html.push_str(&format!(
            "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'nonce-{nonce}'; \
             object-src 'none'; base-uri 'none'; form-action 'none'\">\n"
        ));
        html.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
        html.push_str(&format!("<title>{}</title>\n", escape(&title)));
        html.push_str("<style>\n");
        html.push_str(STYLE);
        html.push_str(&self.highlight_css);
        html.push_str("</style>\n");
        // Resolve the theme before first paint so there is no light/dark flash.
        html.push_str(&format!(
            "<script nonce=\"{nonce}\">window.__MDR_INIT__ = {init};\
             (function(t){{document.documentElement.dataset.theme = t === 'dark' || t === 'light' ? t : \
             (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');}})(__MDR_INIT__.theme);\
             </script>\n"
        ));
        html.push_str("</head>\n<body>\n<main id=\"content\" class=\"markdown-body\">\n");
        html.push_str(&body);
        html.push_str("</main>\n");
        html.push_str(&format!("<script nonce=\"{nonce}\">\n"));
        html.push_str(SCRIPT);
        html.push_str("</script>\n</body>\n</html>\n");

        Page { title, html }
    }
}

fn options() -> Options<'static> {
    let mut o = Options::default();

    let e = &mut o.extension;
    e.strikethrough = true;
    e.table = true;
    e.autolink = true;
    e.tasklist = true;
    e.superscript = true;
    e.subscript = true;
    e.header_id_prefix = Some(String::new());
    e.footnotes = true;
    e.inline_footnotes = true;
    e.description_lists = true;
    e.front_matter_delimiter = Some("---".into());
    e.multiline_block_quotes = true;
    e.alerts = true;
    e.math_dollars = true;
    e.math_code = true;
    e.shortcodes = true;
    e.wikilinks_title_after_pipe = true;
    e.spoiler = true;
    e.highlight = true;
    e.insert = true;
    e.cjk_friendly_emphasis = true;

    o.parse.relaxed_tasklist_matching = true;
    o.parse.tasklist_in_table = true;

    // Raw HTML (<details>, <kbd>, <video>, sized <img>...) is part of everyday
    // markdown; scripts in it are neutralised by the page's CSP instead.
    o.render.r#unsafe = true;
    o.render.sourcepos = true;
    o.render.figure_with_caption = true;
    o.render.tasklist_classes = true;

    o
}

/// Rewrites the nodes comrak cannot render the way we want: math becomes
/// MathML, mermaid fences become diagram hosts, and images that point at
/// video/audio files become players.
fn transform<'a>(root: Node<'a>) {
    let nodes: Vec<Node<'a>> = root.descendants().collect();
    for node in nodes {
        let replacement = match &node.data().value {
            NodeValue::Math(m) => Some(mathml(&m.literal, m.display_math)),
            NodeValue::CodeBlock(cb) => match cb.info.split_whitespace().next().unwrap_or("") {
                "math" => Some(format!(
                    "<div class=\"math-block\">{}</div>\n",
                    mathml(&cb.literal, true)
                )),
                "mermaid" => Some(format!(
                    "<pre class=\"mermaid\">{}</pre>\n",
                    escape(&cb.literal)
                )),
                _ => None,
            },
            NodeValue::Image(link) => media_html(&link.url, &link.title),
            _ => None,
        };
        if let Some(html) = replacement {
            let children: Vec<Node<'a>> = node.children().collect();
            for child in children {
                child.detach();
            }
            node.data_mut().value = NodeValue::Raw(html);
        }
    }
}

fn mathml(latex: &str, display: bool) -> String {
    let storage = Storage::new();
    let parser = LatexParser::new(latex, &storage);
    let config = RenderConfig {
        display_mode: if display {
            DisplayMode::Block
        } else {
            DisplayMode::Inline
        },
        ..Default::default()
    };
    let mut out = String::new();
    match push_mathml(&mut out, parser, config) {
        Ok(()) => out,
        Err(_) => format!("<code class=\"math-error\">{}</code>", escape(latex)),
    }
}

fn media_html(url: &str, title: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    let tag = if VIDEO_EXT.contains(&ext.as_str()) {
        "video"
    } else if AUDIO_EXT.contains(&ext.as_str()) {
        "audio"
    } else {
        return None;
    };
    let title_attr = if title.is_empty() {
        String::new()
    } else {
        format!(" title=\"{}\"", escape(title))
    };
    Some(format!(
        "<{tag} controls preload=\"metadata\" src=\"{}\"{title_attr}></{tag}>",
        escape(url)
    ))
}

fn first_heading<'a>(root: Node<'a>) -> Option<String> {
    let heading = root
        .descendants()
        .find(|n| matches!(&n.data().value, NodeValue::Heading(h) if h.level == 1))?;
    let mut text = String::new();
    for node in heading.descendants() {
        match &node.data().value {
            NodeValue::Text(t) => text.push_str(t),
            NodeValue::Code(c) => text.push_str(&c.literal),
            _ => {}
        }
    }
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Class-based highlighting CSS for both themes; the dark set is nested under
/// the dark theme selector so a theme switch needs no re-render.
fn highlight_css() -> String {
    let themes = ThemeSet::load_defaults();
    let style = ClassStyle::SpacedPrefixed { prefix: HL_PREFIX };
    let css = |name: &str| {
        themes
            .themes
            .get(name)
            .and_then(|t| css_for_theme_with_class_style(t, style).ok())
            .unwrap_or_default()
    };
    format!(
        "\n{}\n:root[data-theme=\"dark\"] {{\n{}\n}}\n",
        css(LIGHT_THEME),
        css(DARK_THEME)
    )
}

fn nonce() -> String {
    // RandomState is seeded from OS randomness; two draws give 128 bits.
    let draw = || {
        std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish()
    };
    format!("{:016x}{:016x}", draw(), draw())
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}
