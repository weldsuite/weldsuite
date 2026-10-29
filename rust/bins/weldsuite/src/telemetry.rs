//! Logs and traces. Logs go to stdout (JSON for the cluster's log pipeline,
//! or text); spans are also exported over OTLP (HTTP, protobuf) when
//! `OTEL_EXPORTER_OTLP_ENDPOINT` is set, e.g. to an OpenTelemetry Collector at
//! `http://otel-collector:4318`. The exporter reads the standard `OTEL_*`
//! variables; `OTEL_SERVICE_NAME` defaults to `weldsuite`.

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::SpanExporter;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::config::LogFormat;

/// Keeps the trace exporter alive; [`Telemetry::shutdown`] flushes it.
pub(crate) struct Telemetry {
    provider: Option<SdkTracerProvider>,
}

impl Telemetry {
    /// Export the spans still buffered. Call once, at exit.
    pub(crate) fn shutdown(self) {
        if let Some(provider) = self.provider
            && let Err(error) = provider.shutdown()
        {
            eprintln!("telemetry: flushing traces failed: {error}");
        }
    }
}

fn otlp_configured() -> bool {
    [
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    ]
    .iter()
    .any(|name| std::env::var(name).is_ok_and(|value| !value.is_empty()))
}

fn tracer_provider() -> Result<SdkTracerProvider, Box<dyn std::error::Error>> {
    let exporter = SpanExporter::builder().with_http().build()?;
    let service = std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "weldsuite".to_owned());
    Ok(SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(
            Resource::builder()
                .with_service_name(service)
                .with_attribute(opentelemetry::KeyValue::new(
                    "service.version",
                    env!("CARGO_PKG_VERSION"),
                ))
                .build(),
        )
        .build())
}

/// Install the global subscriber: `RUST_LOG` filter (default
/// `default_filter`), the log format, and the OTLP layer when configured.
pub(crate) fn init(format: LogFormat, default_filter: &str) -> Telemetry {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter));
    let logs = match format {
        LogFormat::Json => tracing_subscriber::fmt::layer()
            .json()
            .flatten_event(true)
            .boxed(),
        LogFormat::Text => tracing_subscriber::fmt::layer().boxed(),
    };

    let (provider, failure) = if otlp_configured() {
        match tracer_provider() {
            Ok(provider) => (Some(provider), None),
            Err(error) => (None, Some(error.to_string())),
        }
    } else {
        (None, None)
    };
    let traces = provider
        .as_ref()
        .map(|provider| tracing_opentelemetry::layer().with_tracer(provider.tracer("weldsuite")));

    tracing_subscriber::registry()
        .with(filter)
        .with(logs)
        .with(traces)
        .init();
    if let Some(error) = failure {
        tracing::error!(%error, "telemetry: OTLP export is configured but could not start");
    } else if provider.is_some() {
        tracing::info!("telemetry: exporting traces over OTLP");
    }
    Telemetry { provider }
}

#[cfg(test)]
mod tests {
    #[test]
    fn otlp_is_off_without_an_endpoint() {
        // CI and local runs have no collector; the server must start without one.
        if std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT").is_none()
            && std::env::var_os("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").is_none()
        {
            assert!(!super::otlp_configured());
        }
    }
}
