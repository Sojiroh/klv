use crate::error::KlvError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameKind {
    Namespace,
    Pod,
    Container,
    Deployment,
    StatefulSet,
    DaemonSet,
}

impl NameKind {
    fn as_str(self) -> &'static str {
        match self {
            NameKind::Namespace => "namespace",
            NameKind::Pod => "pod",
            NameKind::Container => "container",
            NameKind::Deployment => "deployment",
            NameKind::StatefulSet => "statefulset",
            NameKind::DaemonSet => "daemonset",
        }
    }

    // namespace y container: label RFC 1123 (<= 63); pod y workloads: subdominio RFC 1123 (<= 253)
    fn is_label(self) -> bool {
        matches!(self, NameKind::Namespace | NameKind::Container)
    }
}

// `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
fn is_dns_label(text: &str) -> bool {
    let bytes = text.as_bytes();
    let is_alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    match (bytes.first(), bytes.last()) {
        (Some(&first), Some(&last)) => {
            is_alnum(first) && is_alnum(last) && bytes.iter().all(|&b| is_alnum(b) || b == b'-')
        }
        _ => false,
    }
}

/// Valida un nombre de recurso de Kubernetes antes de usarlo en una petición al apiserver.
pub fn validate_name(kind: NameKind, value: &str) -> Result<(), KlvError> {
    let valid = if kind.is_label() {
        value.len() <= 63 && is_dns_label(value)
    } else {
        value.len() <= 253 && value.split('.').all(is_dns_label)
    };

    if valid {
        Ok(())
    } else {
        Err(KlvError::new(format!(
            "Nombre de {} inválido: \"{value}\"",
            kind.as_str()
        )))
    }
}
