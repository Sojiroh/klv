use serde::Serialize;

/// Error de un comando. `status_code` replica el código HTTP que devuelve la API web para el mismo fallo
/// (400 argumentos inválidos, 409 conflicto, el del apiserver en errores de Kubernetes).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KlvError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
}

impl KlvError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
            status_code: None,
        }
    }

    pub fn with_status(status: u16, msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
            status_code: Some(status),
        }
    }

    /// Error de kube con un prefijo de acción: `"{action}: {detalle}"`, con el código del apiserver.
    pub fn from_kube(action: impl std::fmt::Display, e: &kube::Error) -> Self {
        Self {
            message: format!("{action}: {}", kube_error_message(e)),
            status_code: kube_status(e),
        }
    }

    #[allow(dead_code)]
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(format!("Error interno: {}", msg.into()))
    }
}

impl std::fmt::Display for KlvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for KlvError {}

/// Mensaje legible de un error de kube: para errores del apiserver, el `Status.message`.
pub fn kube_error_message(e: &kube::Error) -> String {
    match e {
        kube::Error::Api(resp) if !resp.message.is_empty() => resp.message.clone(),
        other => other.to_string(),
    }
}

/// Código de un error del apiserver, como lo expone la API web: 4xx tal cual, 5xx como 502 (bad gateway).
pub fn kube_status(e: &kube::Error) -> Option<u16> {
    match e {
        kube::Error::Api(resp) if (400..500).contains(&resp.code) => Some(resp.code),
        kube::Error::Api(resp) if resp.code >= 500 => Some(502),
        _ => None,
    }
}

impl From<kube::Error> for KlvError {
    fn from(e: kube::Error) -> Self {
        Self {
            message: kube_error_message(&e),
            status_code: kube_status(&e),
        }
    }
}

impl From<std::io::Error> for KlvError {
    fn from(e: std::io::Error) -> Self {
        Self::new(e.to_string())
    }
}

impl From<serde_json::Error> for KlvError {
    fn from(e: serde_json::Error) -> Self {
        Self::new(e.to_string())
    }
}
