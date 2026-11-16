//! `ctx.host.network.request` (kernel-design §7.5, D307–D309): http/https only; hosts from the
//! manifest or from the plugin's own resources, intersected with every `network.allow` layer;
//! redirects followed by hand (≤ 5, each hop checked); no loopback or link-local address unless
//! written out explicitly; every call audited, repeated ones per run counted.

use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use onedesk_protocol::*;
use serde_json::{json, Map, Value};

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::pipeline::Command;
use crate::sandbox::CallInfo;
use crate::store;
use crate::util::*;

pub const MAX_BODY: usize = 8 * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 5;
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MAX_TIMEOUT_MS: u64 = 60_000;
/// The configuration / environment parameter that narrows network access (§6.3).
pub const ALLOW_PARAM: &str = "network.allow";
/// D316: the methods a plugin may use.
pub const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
/// D316: connection-level headers the host sets, never the plugin.
const FORBIDDEN_HEADERS: &[&str] = &["host", "content-length", "transfer-encoding", "connection"];
/// D316: dropped on a redirect to another host (with headers that carried a substituted secret).
const CREDENTIAL_HEADERS: &[&str] = &["authorization", "cookie", "proxy-authorization"];

/// The host of a URL (lower case), if it has one.
pub fn host_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url.trim()).ok().and_then(|u| u.host_str().map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase()))
}

/// A host pattern: `host`, `host:port`, `*.domain`.
struct Pattern {
    host: String,
    port: Option<u16>,
    wildcard: bool,
}

fn pattern(p: &str) -> Option<Pattern> {
    let p = p.trim().to_ascii_lowercase();
    if p.is_empty() {
        return None;
    }
    let (h, port) = match p.rsplit_once(':') {
        Some((h, port)) if !h.contains(':') => (h.to_string(), Some(port.parse().ok()?)),
        _ => (p.clone(), None),
    };
    match h.strip_prefix("*.") {
        Some(d) => Some(Pattern { host: d.to_string(), port, wildcard: true }),
        None => Some(Pattern { host: h, port, wildcard: false }),
    }
}

impl Pattern {
    /// D317: without a port an entry means the web ports (80, 443) only; with one, exactly it.
    fn matches(&self, host: &str, port: u16) -> bool {
        let host_ok = if self.wildcard { host.ends_with(&format!(".{}", self.host)) } else { host == self.host };
        host_ok && self.port.map_or(port == 80 || port == 443, |p| p == port)
    }
}

/// `host:port` of a URL (port: the given one, or the scheme's default) — what a granting field grants.
pub fn host_port_of(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url.trim()).ok()?;
    let host = u.host_str()?.trim_matches(['[', ']']).to_ascii_lowercase();
    let port = u.port_or_known_default()?;
    Some(format!("{host}:{port}"))
}

/// Whether some pattern of `list` matches; `explicit` = an exact (non-wildcard) entry names it.
fn match_list(list: &[String], host: &str, port: u16) -> (bool, bool) {
    let ps: Vec<Pattern> = list.iter().filter_map(|p| pattern(p)).collect();
    let any = ps.iter().any(|p| p.matches(host, port));
    let explicit = ps.iter().any(|p| !p.wildcard && p.matches(host, port));
    (any, explicit)
}

/// A `network.allow` value: one pattern per line (commas also separate).
pub fn allow_list(value: &str) -> Vec<String> {
    value.split(['\n', ',']).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

fn local_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_loopback() || v.is_link_local() || v.is_unspecified(),
        IpAddr::V6(v) => {
            v.is_loopback() || v.is_unspecified() || (v.segments()[0] & 0xffc0) == 0xfe80 || v.to_ipv4_mapped().is_some_and(|m| m.is_loopback() || m.is_link_local())
        }
    }
}

/// What `http_open` sends besides the plugin's options.
pub(crate) struct Request<'a> {
    pub default_method: &'a str,
    pub methods: &'a [&'a str],
    /// The whole call's end (name resolution, every hop, and the caller's reading of the body).
    pub deadline: tokio::time::Instant,
    /// A file sent as the request body (`transfer.upload`), instead of the options' `body`.
    pub file: Option<FileBody>,
}

/// A file sent as a request body in chunks of at most `CHUNK` bytes, counting what went out.
pub(crate) struct FileBody {
    /// Opened (and checked) once; every hop reads it again from the start (review #3).
    pub file: std::fs::File,
    pub size: u64,
    pub sent: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

/// Bytes moved per read or write by `transfer` (round 8 §3: never more than 64 KB at a time).
pub const CHUNK: usize = 64 * 1024;

impl FileBody {
    async fn body(&self) -> KResult<reqwest::Body> {
        use std::io::Seek;
        let mut f = self.file.try_clone().map_err(internal)?;
        f.seek(std::io::SeekFrom::Start(0)).map_err(internal)?;
        let f = tokio::fs::File::from_std(f);
        self.sent.store(0, std::sync::atomic::Ordering::SeqCst);
        Ok(reqwest::Body::wrap(FileStream { f, sent: self.sent.clone(), buf: vec![0u8; CHUNK] }))
    }
}

/// A file as an HTTP body: one read of at most `CHUNK` bytes per frame.
struct FileStream {
    f: tokio::fs::File,
    sent: std::sync::Arc<std::sync::atomic::AtomicU64>,
    buf: Vec<u8>,
}

impl http_body::Body for FileStream {
    type Data = bytes::Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<bytes::Bytes>, std::io::Error>>> {
        use std::task::Poll;
        let me = self.get_mut();
        let mut rb = tokio::io::ReadBuf::new(&mut me.buf);
        match tokio::io::AsyncRead::poll_read(std::pin::Pin::new(&mut me.f), cx, &mut rb) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
            Poll::Ready(Ok(())) if rb.filled().is_empty() => Poll::Ready(None),
            Poll::Ready(Ok(())) => {
                let chunk = bytes::Bytes::copy_from_slice(rb.filled());
                me.sent.fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::SeqCst);
                Poll::Ready(Some(Ok(http_body::Frame::data(chunk))))
            }
        }
    }
}

/// The final response of `http_open`, and what the caller needs to finish the call.
pub(crate) struct Sent {
    pub resp: reqwest::Response,
    /// The host answered (for the audit).
    pub host: String,
    pub method: String,
    pub url: reqwest::Url,
    /// Secret values substituted (scrubbed from whatever goes back to the plugin).
    pub used: Vec<String>,
}

impl Sent {
    pub fn headers(&self) -> Map<String, Value> {
        let mut out = Map::new();
        for (k, v) in self.resp.headers() {
            out.insert(k.as_str().to_string(), json!(String::from_utf8_lossy(v.as_bytes())));
        }
        out
    }
}

/// An error while reading a response body: the client's own time limit is `invalid/timeout` too.
pub(crate) fn read_error(e: reqwest::Error) -> ProtocolError {
    if e.is_timeout() { err_p(ErrorCode::Invalid, &[("reason", "timeout")]) } else { err_d(ErrorCode::Invalid, e.to_string()) }
}

/// A response body as text, kept up to `MAX_BODY` bytes (and whether more came).
pub(crate) async fn read_text_body(mut resp: reqwest::Response, deadline: tokio::time::Instant) -> KResult<(Vec<u8>, bool)> {
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::time::timeout(deadline.saturating_duration_since(tokio::time::Instant::now()), resp.chunk())
            .await
            .map_err(|_| err_p(ErrorCode::Invalid, &[("reason", "timeout")]))?
            .map_err(read_error)?;
        let Some(c) = chunk else { break };
        let room = MAX_BODY - bytes.len();
        if c.len() > room {
            bytes.extend_from_slice(&c[..room]);
            return Ok((bytes, true));
        }
        bytes.extend_from_slice(&c);
    }
    Ok((bytes, false))
}

impl Inner {
    /// Hosts the plugin may reach: its manifest's, and (with `fromResources`) the hosts of the
    /// granting fields of its own live resources.
    pub fn granted_hosts(&self, p: &Plugin) -> KResult<Vec<String>> {
        let Some(n) = &p.manifest.requires.network else { return Ok(vec![]) };
        let mut out = n.hosts.clone();
        if n.from_resources {
            for k in &p.manifest.contributes.kinds {
                let fields: Vec<&String> = k.fields.iter().filter(|(_, f)| f.grants.as_deref() == Some("network")).map(|(n, _)| n).collect();
                if fields.is_empty() {
                    continue;
                }
                for r in self.read(|c| store::of_kind(c, &p.full(&k.id)))? {
                    for f in &fields {
                        if let Some(h) = r.body.get(f.as_str()).and_then(Value::as_str).and_then(host_port_of) {
                            out.push(h);
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    /// Hosts a resource body grants (its kind's `"grants": "network"` fields).
    pub fn grant_hosts_of(&self, kind: &str, version: Option<&str>, body: &JsonMap) -> BTreeSet<String> {
        let Some((_, k)) = self.registry.kind_at(kind, version) else { return BTreeSet::new() };
        k.fields
            .iter()
            .filter(|(_, f)| f.grants.as_deref() == Some("network"))
            .filter_map(|(n, _)| body.get(n).and_then(Value::as_str).and_then(host_port_of))
            .collect()
    }

    /// The `network.allow` layers in force: configuration nodes, then the call's environment chain.
    fn allow_layers(&self, env: Option<&str>) -> KResult<Vec<Vec<String>>> {
        let mut layers = Vec::new();
        for r in self.read(|c| store::of_kind(c, store::KIND_CONFIG))? {
            if let Some(p) = crate::params::get(&r, ALLOW_PARAM) {
                layers.push(allow_list(&p.value));
            }
        }
        if let Some(e) = env.and_then(|e| self.read(|c| store::get(c, e)).ok().flatten()).filter(|r| r.kind == store::KIND_ENV) {
            let mut chain = self.read(|c| store::ancestors(c, &e))?;
            chain.push(e);
            for r in chain {
                if let Some(p) = crate::params::get(&r, ALLOW_PARAM) {
                    layers.push(allow_list(&p.value));
                }
            }
        }
        Ok(layers)
    }

    /// One hop's checks; returns the address to connect to (pinned: no second DNS answer).
    async fn check_hop(&self, granted: &[String], layers: &[Vec<String>], url: &reqwest::Url) -> KResult<(String, SocketAddr)> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(invalid("badScheme"));
        }
        let host = url.host_str().map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase()).ok_or_else(|| invalid("badUrl"))?;
        let port = url.port_or_known_default().ok_or_else(|| invalid("badUrl"))?;
        let (ok, explicit) = match_list(granted, &host, port);
        if !ok {
            return Err(denied("hostNotAllowed"));
        }
        // §6.3: every layer that defines a list must contain the host; an empty list allows nothing.
        for l in layers {
            if !match_list(l, &host, port).0 {
                return Err(denied("blockedByPolicy"));
            }
        }
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| err_p(ErrorCode::NotFound, &[("what", "host")]))?
            .collect();
        let addr = *addrs.first().ok_or_else(|| err_p(ErrorCode::NotFound, &[("what", "host")]))?;
        // D308: no loopback / link-local unless the allow list names exactly this host (or IP).
        if addrs.iter().any(|a| local_address(a.ip())) && !explicit {
            return Err(denied("localAddress"));
        }
        Ok((host, addr))
    }

    pub async fn host_network(&self, p: &'static Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        let o = args.get(0).and_then(Value::as_object).ok_or_else(|| invalid_params("request"))?;
        let timeout = o.get("timeoutMs").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, MAX_TIMEOUT_MS);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
        let sent = self.http_open(p, info, o, Request { default_method: "GET", methods: METHODS, deadline, file: None }).await?;
        let (status, out_headers) = (sent.resp.status().as_u16(), sent.headers());
        let (bytes, truncated) = read_text_body(sent.resp, deadline).await?;
        let url = &sent.url;
        let summary = json!({ "method": sent.method, "pathLength": url.path().len() + url.query().map_or(0, |q| q.len() + 1), "status": status });
        let _ = self
            .pipeline
            .execute(p.actor(), Command::CountedAudit { run: info.run_id.clone(), op: "network.request".into(), object: sent.host, summary, failed: status >= 400, error: None })
            .await;
        self.emit(onedesk_protocol::topic2::AUDIT, None, None);
        let mut out = json!({
            "status": status,
            "headers": out_headers,
            "body": String::from_utf8_lossy(&bytes),
            "truncated": truncated,
        });
        // §7.5: the original value of a substituted secret never reaches the plugin.
        crate::secrets::scrub(&mut out, &sent.used);
        Ok(out)
    }

    /// Everything `network.request` checks and does up to the final response (round 8: shared
    /// with `transfer.download` / `transfer.upload`): the plugin's network permission, method,
    /// secret substitution in the address, headers and text body, hosts and `network.allow` on
    /// every hop, redirects by hand.
    pub(crate) async fn http_open(&self, p: &'static Plugin, info: &CallInfo, o: &Map<String, Value>, r: Request<'_>) -> KResult<Sent> {
        let has_network = p.manifest.requires.network.as_ref().is_some_and(|n| !n.hosts.is_empty() || n.from_resources);
        if !has_network {
            return Err(denied("notRequested"));
        }
        let mut method = o.get("method").and_then(Value::as_str).unwrap_or(r.default_method).to_ascii_uppercase();
        if !r.methods.contains(&method.as_str()) {
            return Err(invalid("badMethod"));
        }
        let raw_url = o.get("url").and_then(Value::as_str).ok_or_else(|| invalid_params("url"))?;
        let deadline = r.deadline;
        let allowed_secrets = self.plugin_secret_names(p, info.resource_id.as_deref())?;
        let mut used = Vec::new();
        let url_text = self.substitute(p, raw_url, &allowed_secrets, &mut used)?;
        // (name, value, carries a substituted secret)
        let mut headers: Vec<(String, String, bool)> = Vec::new();
        if let Some(h) = o.get("headers").and_then(Value::as_object) {
            for (k, v) in h {
                if FORBIDDEN_HEADERS.contains(&k.to_ascii_lowercase().as_str()) {
                    return Err(err_p(ErrorCode::Invalid, &[("reason", "forbiddenHeader"), ("header", k)]));
                }
                let v = v.as_str().map(String::from).unwrap_or_else(|| v.to_string());
                let secret = !crate::secrets::references(&v).is_empty();
                headers.push((k.clone(), self.substitute(p, &v, &allowed_secrets, &mut used)?, secret));
            }
        }
        let mut body = match o.get("body") {
            _ if r.file.is_some() => None,
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(self.substitute(p, s, &allowed_secrets, &mut used)?),
            Some(other) => Some(self.substitute(p, &other.to_string(), &allowed_secrets, &mut used)?),
        };
        let mut file = r.file;
        let granted = self.granted_hosts(p)?;
        let layers = self.allow_layers(info.env_id.as_deref())?;
        let mut url = reqwest::Url::parse(&url_text).map_err(|_| invalid("badUrl"))?;
        let left = || deadline.saturating_duration_since(tokio::time::Instant::now());
        let mut hops = 0;
        let mut origin: Option<(String, u16)> = None;
        loop {
            // D316: name resolution counts against the same time budget.
            let (host, addr) = tokio::time::timeout(left(), self.check_hop(&granted, &layers, &url))
                .await
                .map_err(|_| err_p(ErrorCode::Invalid, &[("reason", "timeout")]))??;
            // D316: on a hop to another host (or port), credentials and substituted secrets stay behind.
            let here = (host.clone(), addr.port());
            if origin.as_ref().is_some_and(|o| o != &here) {
                headers.retain(|(k, _, secret)| !secret && !CREDENTIAL_HEADERS.contains(&k.to_ascii_lowercase().as_str()));
            }
            origin = Some(here);
            let client = reqwest::Client::builder()
                // No proxy from the environment: it would bypass the pinned address and loopback check.
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .resolve(&host, addr)
                .timeout(left().max(Duration::from_millis(1)))
                .build()
                .map_err(internal)?;
            let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| invalid("badMethod"))?;
            let mut req = client.request(m, url.clone());
            for (k, v, _) in &headers {
                req = req.header(k, v);
            }
            if let Some(b) = &body {
                req = req.body(b.clone());
            }
            if let Some(f) = &file {
                // Opened again for every hop (a 307/308 sends the content again).
                req = req.header(reqwest::header::CONTENT_LENGTH, f.size).body(f.body().await?);
            }
            let resp = req.send().await.map_err(|e| {
                if e.is_timeout() { err_p(ErrorCode::Invalid, &[("reason", "timeout")]) } else { err_d(ErrorCode::Invalid, e.to_string()) }
            })?;
            let status = resp.status();
            let location = resp.headers().get(reqwest::header::LOCATION).and_then(|l| l.to_str().ok()).map(String::from);
            match location {
                Some(loc) if status.is_redirection() => {
                    hops += 1;
                    if hops > MAX_REDIRECTS {
                        return Err(invalid("tooManyRedirects"));
                    }
                    url = url.join(&loc).map_err(|_| invalid("badUrl"))?;
                    if status == reqwest::StatusCode::SEE_OTHER
                        || ((status == reqwest::StatusCode::MOVED_PERMANENTLY || status == reqwest::StatusCode::FOUND) && method == "POST")
                    {
                        method = "GET".into();
                        body = None;
                        file = None;
                    }
                }
                _ => return Ok(Sent { resp, host, method, url, used }),
            }
        }
    }

    /// `EnvParam.restricted` for `network.allow`: entries an upper layer does not allow (§6.3).
    pub fn allow_restricted(&self, env: &crate::store::Row, ancestors: &[crate::store::Row]) -> bool {
        let Some(own) = crate::params::get(env, ALLOW_PARAM) else { return false };
        let mut uppers: Vec<Vec<String>> = Vec::new();
        for r in self.read(|c| store::of_kind(c, store::KIND_CONFIG)).unwrap_or_default() {
            if let Some(p) = crate::params::get(&r, ALLOW_PARAM) {
                uppers.push(allow_list(&p.value));
            }
        }
        for a in ancestors {
            if let Some(p) = crate::params::get(a, ALLOW_PARAM) {
                uppers.push(allow_list(&p.value));
            }
        }
        allow_list(&own.value).iter().any(|entry| {
            let Some(pt) = pattern(entry) else { return false };
            let probe = if pt.wildcard { format!("x.{}", pt.host) } else { pt.host.clone() };
            uppers.iter().any(|u| !match_list(u, &probe, pt.port.unwrap_or(443)).0)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_match_hosts_ports_and_subdomains() {
        let l = vec!["api.example.com".to_string(), "*.example.org".into(), "localhost:8080".into()];
        assert_eq!(match_list(&l, "api.example.com", 443), (true, true));
        assert!(match_list(&l, "api.example.com", 80).0);
        assert!(!match_list(&l, "api.example.com", 8443).0, "no port written = 80 and 443 only (D317)");
        assert_eq!(host_port_of("http://127.0.0.1:18941/x"), Some("127.0.0.1:18941".into()));
        assert_eq!(host_port_of("https://a.example/x"), Some("a.example:443".into()));
        assert_eq!(match_list(&l, "x.example.org", 443), (true, false));
        assert!(!match_list(&l, "example.org", 443).0, "wildcard is subdomains only");
        assert_eq!(match_list(&l, "localhost", 8080), (true, true));
        assert!(!match_list(&l, "localhost", 8081).0);
        assert!(!match_list(&l, "evil.com", 443).0);
        assert_eq!(allow_list("a.com, b.com\nc.com\n"), vec!["a.com", "b.com", "c.com"]);
        assert_eq!(host_of("https://User@Api.Example.com:8443/x?y"), Some("api.example.com".into()));
        assert!(local_address("127.0.0.1".parse().unwrap()) && local_address("169.254.1.1".parse().unwrap()));
        assert!(local_address("::1".parse().unwrap()) && local_address("fe80::1".parse().unwrap()));
        assert!(!local_address("93.184.216.34".parse().unwrap()));
    }
}
