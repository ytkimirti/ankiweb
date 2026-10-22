// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

//! The subset of reqwest's async API that rslib uses, for wasm32-wasip1.
//!
//! WASI preview 1 has no sockets, so requests are handed to the host through
//! the `ankiweb` import module. The web worker that hosts the module has its
//! IO worker perform them and waits, which blocks only that worker. Each
//! request future yields once before running, so a cooperative executor can
//! interleave other work between network round trips.
//!
//! rslib imports this crate as `reqwest` on WASI targets, so the type and
//! method names mirror reqwest's.

mod host;

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;
use std::time::Duration;

use bytes::Bytes;
use futures::Stream;
use futures::StreamExt;
use futures::TryStreamExt;
pub use http::header;
use http::header::HeaderMap;
use http::header::HeaderName;
use http::header::HeaderValue;
pub use http::Method;
pub use http::StatusCode;
use serde::de::DeserializeOwned;
use serde::Serialize;
pub use url::Url;

pub type Result<T, E = Error> = std::result::Result<T, E>;
type BoxError = Box<dyn std::error::Error + Send + Sync>;

// Errors
//////////////////////////////////////////////////////////////////////////////

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Builder,
    Request,
    Timeout,
    Connect,
    Status,
    Body,
    Decode,
}

pub struct Error {
    kind: Kind,
    url: Option<Url>,
    status: Option<StatusCode>,
    source: Option<BoxError>,
}

impl Error {
    fn new(kind: Kind, source: Option<BoxError>) -> Self {
        Error {
            kind,
            url: None,
            status: None,
            source,
        }
    }

    fn with_url(mut self, url: Url) -> Self {
        self.url = Some(url);
        self
    }

    pub fn url(&self) -> Option<&Url> {
        self.url.as_ref()
    }

    pub fn without_url(mut self) -> Self {
        self.url = None;
        self
    }

    pub fn status(&self) -> Option<StatusCode> {
        self.status
    }

    pub fn is_timeout(&self) -> bool {
        self.kind == Kind::Timeout
    }

    pub fn is_connect(&self) -> bool {
        self.kind == Kind::Connect
    }

    pub fn is_status(&self) -> bool {
        self.kind == Kind::Status
    }

    pub fn is_request(&self) -> bool {
        self.kind == Kind::Request
    }

    pub fn is_body(&self) -> bool {
        self.kind == Kind::Body
    }

    pub fn is_decode(&self) -> bool {
        self.kind == Kind::Decode
    }

    pub fn is_builder(&self) -> bool {
        self.kind == Kind::Builder
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("reqwest::Error")
            .field("kind", &self.kind)
            .field("url", &self.url.as_ref().map(|u| u.as_str()))
            .field("status", &self.status)
            .field("source", &self.source)
            .finish()
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            Kind::Builder => f.write_str("builder error")?,
            Kind::Request => f.write_str("error sending request")?,
            Kind::Timeout => f.write_str("operation timed out")?,
            Kind::Connect => f.write_str("error sending request: network unreachable")?,
            Kind::Body => f.write_str("request or response body error")?,
            Kind::Decode => f.write_str("error decoding response body")?,
            Kind::Status => {
                let code = self.status.unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let prefix = if code.is_client_error() {
                    "HTTP status client error"
                } else {
                    "HTTP status server error"
                };
                write!(f, "{prefix} ({code})")?;
            }
        }
        if let Some(url) = &self.url {
            write!(f, " for url ({url})")?;
        }
        if let Some(source) = &self.source {
            write!(f, ": {source}")?;
        }
        Ok(())
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_ref().map(|e| &**e as _)
    }
}

// URLs
//////////////////////////////////////////////////////////////////////////////

pub trait IntoUrl {
    fn into_url(self) -> Result<Url>;
}

impl IntoUrl for Url {
    fn into_url(self) -> Result<Url> {
        Ok(self)
    }
}

impl IntoUrl for &str {
    fn into_url(self) -> Result<Url> {
        Url::parse(self).map_err(|e| Error::new(Kind::Builder, Some(Box::new(e))))
    }
}

impl IntoUrl for &String {
    fn into_url(self) -> Result<Url> {
        self.as_str().into_url()
    }
}

impl IntoUrl for String {
    fn into_url(self) -> Result<Url> {
        self.as_str().into_url()
    }
}

// Client
//////////////////////////////////////////////////////////////////////////////

#[derive(Clone, Debug, Default)]
pub struct Client {
    timeout: Option<Duration>,
    user_agent: Option<String>,
}

impl Client {
    pub fn new() -> Client {
        Client::default()
    }

    pub fn builder() -> ClientBuilder {
        ClientBuilder {
            client: Client::default(),
        }
    }

    pub fn get<U: IntoUrl>(&self, url: U) -> RequestBuilder {
        self.request(Method::GET, url)
    }

    pub fn post<U: IntoUrl>(&self, url: U) -> RequestBuilder {
        self.request(Method::POST, url)
    }

    pub fn request<U: IntoUrl>(&self, method: Method, url: U) -> RequestBuilder {
        let mut headers = HeaderMap::new();
        if let Some(agent) = &self.user_agent {
            if let Ok(value) = HeaderValue::from_str(agent) {
                headers.insert(header::USER_AGENT, value);
            }
        }
        RequestBuilder {
            method,
            url: url.into_url(),
            headers,
            body: None,
            timeout: self.timeout,
        }
    }
}

#[derive(Debug)]
pub struct ClientBuilder {
    client: Client,
}

impl ClientBuilder {
    pub fn build(self) -> Result<Client> {
        Ok(self.client)
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.client.timeout = Some(timeout);
        self
    }

    pub fn connect_timeout(self, _timeout: Duration) -> Self {
        self
    }

    pub fn user_agent<V: Into<String>>(mut self, agent: V) -> Self {
        self.client.user_agent = Some(agent.into());
        self
    }

    pub fn http1_only(self) -> Self {
        self
    }

    pub fn no_proxy(self) -> Self {
        self
    }
}

// Bodies
//////////////////////////////////////////////////////////////////////////////

pub struct Body(BodyInner);

enum BodyInner {
    Bytes(Bytes),
    Stream(Pin<Box<dyn Stream<Item = Result<Bytes, BoxError>> + Send>>),
}

impl Body {
    pub fn wrap_stream<S>(stream: S) -> Body
    where
        S: futures::TryStream + Send + 'static,
        S::Error: Into<BoxError>,
        Bytes: From<S::Ok>,
    {
        Body(BodyInner::Stream(Box::pin(
            stream.map_ok(Bytes::from).map_err(Into::into),
        )))
    }

    async fn collect(self) -> Result<Bytes> {
        match self.0 {
            BodyInner::Bytes(bytes) => Ok(bytes),
            BodyInner::Stream(mut stream) => {
                let mut out = Vec::new();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| Error::new(Kind::Body, Some(e)))?;
                    out.extend_from_slice(&chunk);
                }
                Ok(out.into())
            }
        }
    }
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Body")
    }
}

impl From<Vec<u8>> for Body {
    fn from(v: Vec<u8>) -> Self {
        Body(BodyInner::Bytes(v.into()))
    }
}

impl From<Bytes> for Body {
    fn from(v: Bytes) -> Self {
        Body(BodyInner::Bytes(v))
    }
}

impl From<String> for Body {
    fn from(v: String) -> Self {
        Body(BodyInner::Bytes(v.into()))
    }
}

impl From<&'static str> for Body {
    fn from(v: &'static str) -> Self {
        Body(BodyInner::Bytes(Bytes::from_static(v.as_bytes())))
    }
}

impl From<&'static [u8]> for Body {
    fn from(v: &'static [u8]) -> Self {
        Body(BodyInner::Bytes(Bytes::from_static(v)))
    }
}

// Requests
//////////////////////////////////////////////////////////////////////////////

#[derive(Debug)]
pub struct RequestBuilder {
    method: Method,
    url: Result<Url>,
    headers: HeaderMap,
    body: Option<Body>,
    timeout: Option<Duration>,
}

impl RequestBuilder {
    pub fn header<K, V>(mut self, key: K, value: V) -> Self
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        match (HeaderName::try_from(key), HeaderValue::try_from(value)) {
            (Ok(key), Ok(value)) => {
                self.headers.insert(key, value);
            }
            (Err(e), _) => self.fail(e.into()),
            (_, Err(e)) => self.fail(e.into()),
        }
        self
    }

    pub fn headers(mut self, headers: HeaderMap) -> Self {
        self.headers.extend(headers);
        self
    }

    pub fn body<T: Into<Body>>(mut self, body: T) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn json<T: Serialize + ?Sized>(mut self, json: &T) -> Self {
        match serde_json::to_vec(json) {
            Ok(data) => {
                self.headers.insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                );
                self.body = Some(data.into());
            }
            Err(e) => self.fail_with(Error::new(Kind::Builder, Some(Box::new(e)))),
        }
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    fn fail(&mut self, err: http::Error) {
        self.fail_with(Error::new(Kind::Builder, Some(Box::new(err))));
    }

    fn fail_with(&mut self, err: Error) {
        if self.url.is_ok() {
            self.url = Err(err);
        }
    }

    pub async fn send(self) -> Result<Response> {
        let url = self.url?;
        let body = match self.body {
            Some(body) => body.collect().await.map_err(|e| e.with_url(url.clone()))?,
            None => Bytes::new(),
        };
        // give a cooperative executor a chance to run other work first
        YieldOnce(false).await;
        let headers = self
            .headers
            .iter()
            .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
            .collect();
        let request = host::Request {
            method: self.method.as_str().to_string(),
            url: url.to_string(),
            headers,
            timeout_ms: self.timeout.map(|t| t.as_millis() as u64).unwrap_or(0),
        };
        let response = host::send(&request, &body).map_err(|failure| {
            let kind = match failure.kind.as_str() {
                "timeout" => Kind::Timeout,
                "connect" => Kind::Connect,
                _ => Kind::Request,
            };
            Error::new(kind, Some(failure.message.into())).with_url(url.clone())
        })?;
        let mut headers = HeaderMap::new();
        for (key, value) in response.headers {
            if let (Ok(key), Ok(value)) = (
                HeaderName::from_bytes(key.as_bytes()),
                HeaderValue::from_str(&value),
            ) {
                headers.append(key, value);
            }
        }
        let final_url = Url::parse(&response.url).unwrap_or(url);
        Ok(Response {
            status: StatusCode::from_u16(response.status)
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            headers,
            url: final_url,
            body: response.body.into(),
        })
    }
}

struct YieldOnce(bool);

impl Future for YieldOnce {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            Poll::Ready(())
        } else {
            self.0 = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

// Responses
//////////////////////////////////////////////////////////////////////////////

#[derive(Debug)]
pub struct Response {
    status: StatusCode,
    headers: HeaderMap,
    url: Url,
    body: Bytes,
}

impl Response {
    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    pub fn url(&self) -> &Url {
        &self.url
    }

    pub fn content_length(&self) -> Option<u64> {
        Some(self.body.len() as u64)
    }

    pub fn error_for_status(self) -> Result<Self> {
        if self.status.is_client_error() || self.status.is_server_error() {
            let mut err = Error::new(Kind::Status, None).with_url(self.url);
            err.status = Some(self.status);
            Err(err)
        } else {
            Ok(self)
        }
    }

    pub fn error_for_status_ref(&self) -> Result<&Self> {
        if self.status.is_client_error() || self.status.is_server_error() {
            let mut err = Error::new(Kind::Status, None).with_url(self.url.clone());
            err.status = Some(self.status);
            Err(err)
        } else {
            Ok(self)
        }
    }

    pub async fn bytes(self) -> Result<Bytes> {
        Ok(self.body)
    }

    pub async fn text(self) -> Result<String> {
        Ok(String::from_utf8_lossy(&self.body).into_owned())
    }

    pub async fn json<T: DeserializeOwned>(self) -> Result<T> {
        serde_json::from_slice(&self.body)
            .map_err(|e| Error::new(Kind::Decode, Some(Box::new(e))).with_url(self.url))
    }

    pub fn bytes_stream(self) -> impl Stream<Item = Result<Bytes>> + Send + Sync + 'static {
        const CHUNK: usize = 64 * 1024;
        let body = self.body;
        let chunks: Vec<Result<Bytes>> = (0..body.len())
            .step_by(CHUNK)
            .map(|start| Ok(body.slice(start..(start + CHUNK).min(body.len()))))
            .collect();
        futures::stream::iter(chunks)
    }
}
