use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct KlvError {
    pub message: String,
}

impl KlvError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
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

impl From<kube::Error> for KlvError {
    fn from(e: kube::Error) -> Self {
        Self::new(kube_error_message(&e))
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
