//! Evaluador del lenguaje de consultas (contrato Q1). El AST llega ya parseado desde el cliente;
//! la semántica debe coincidir con `matchesQuery` de `packages/core/src/query.ts`.

use std::borrow::Cow;
use std::cell::OnceCell;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::parser::log_parser::{level_priority, LogLevel, ParsedLog};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReservedField {
    Level,
    Service,
    Pod,
    Container,
    Namespace,
    Trace,
    Span,
    Caller,
    Message,
    Error,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum QueryField {
    Reserved { name: ReservedField },
    Attr { path: String },
}

/// Valor de un comparador: número, o nombre de nivel (`LogLevel`) solo para `level`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CompareValue {
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum FieldTest {
    Eq { value: String, wildcard: bool },
    Exists,
    Gt { value: CompareValue },
    Gte { value: CompareValue },
    Lt { value: CompareValue },
    Lte { value: CompareValue },
    Range { min: f64, max: f64 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum QueryNode {
    And {
        children: Vec<QueryNode>,
    },
    Or {
        children: Vec<QueryNode>,
    },
    Not {
        child: Box<QueryNode>,
    },
    Text {
        value: String,
        wildcard: bool,
    },
    Field {
        field: QueryField,
        #[serde(flatten)]
        test: FieldTest,
    },
}

/// Log a evaluar junto con el contexto que `ParsedLog` no lleva (namespace/container).
pub struct QueryTarget<'a> {
    pub log: &'a ParsedLog,
    pub namespace: Option<&'a str>,
    pub container: Option<&'a str>,
}

/// `None` (consulta vacía) coincide con todo.
pub fn matches_query(target: &QueryTarget<'_>, node: Option<&QueryNode>) -> bool {
    let Some(node) = node else {
        return true;
    };
    let ctx = Ctx {
        target,
        search_lower: OnceCell::new(),
    };
    ctx.eval(node)
}

struct Ctx<'a, 't> {
    target: &'t QueryTarget<'a>,
    /// Texto de búsqueda en minúsculas; se calcula solo si algún nodo `text` lo necesita.
    search_lower: OnceCell<String>,
}

/// Valor resuelto de un campo (ausente = `None` en `resolve`).
enum Resolved<'a> {
    Str(&'a str),
    Json(&'a Value),
}

impl<'a> Ctx<'a, '_> {
    fn eval(&self, node: &QueryNode) -> bool {
        match node {
            QueryNode::And { children } => children.iter().all(|c| self.eval(c)),
            QueryNode::Or { children } => children.iter().any(|c| self.eval(c)),
            QueryNode::Not { child } => !self.eval(child),
            QueryNode::Text { value, wildcard } => self.eval_text(value, *wildcard),
            QueryNode::Field { field, test } => self.eval_field(field, test),
        }
    }

    fn eval_text(&self, value: &str, wildcard: bool) -> bool {
        let haystack = self.search_lower.get_or_init(|| search_text(self.target).to_lowercase());
        let needle = value.to_lowercase();
        if wildcard {
            glob_match(haystack, &needle, false)
        } else {
            haystack.contains(&needle)
        }
    }

    fn resolve(&self, field: &QueryField) -> Option<Resolved<'a>> {
        let log: &'a ParsedLog = self.target.log;
        match field {
            QueryField::Reserved { name } => match name {
                ReservedField::Level => Some(Resolved::Str(level_name(&log.level))),
                ReservedField::Service => log.service.as_deref().map(Resolved::Str),
                ReservedField::Pod => log.pod_name.as_deref().map(Resolved::Str),
                ReservedField::Container => self.target.container.map(Resolved::Str),
                ReservedField::Namespace => self.target.namespace.map(Resolved::Str),
                ReservedField::Trace => log.trace_id.as_deref().map(Resolved::Str),
                ReservedField::Span => log.span_id.as_deref().map(Resolved::Str),
                ReservedField::Caller => log.caller.as_deref().map(Resolved::Str),
                ReservedField::Message => Some(Resolved::Str(log.message.as_str())),
                ReservedField::Error => log.error.as_deref().map(Resolved::Str),
            },
            QueryField::Attr { path } => resolve_attr(&log.extra, path).map(Resolved::Json),
        }
    }

    fn eval_field(&self, field: &QueryField, test: &FieldTest) -> bool {
        if matches!(
            field,
            QueryField::Reserved {
                name: ReservedField::Level
            }
        ) {
            return self.eval_level(test);
        }
        let Some(resolved) = self.resolve(field) else {
            return false;
        };

        match test {
            FieldTest::Eq { value, wildcard } => {
                let expected = value.to_lowercase();
                any_string(&resolved, &|candidate| {
                    let candidate = candidate.to_lowercase();
                    if *wildcard {
                        glob_match(&candidate, &expected, true)
                    } else {
                        candidate == expected
                    }
                })
            }
            FieldTest::Exists => any_string(&resolved, &|candidate| !candidate.is_empty()),
            FieldTest::Gt { value } => compare_number(&resolved, value, |c, v| c > v),
            FieldTest::Gte { value } => compare_number(&resolved, value, |c, v| c >= v),
            FieldTest::Lt { value } => compare_number(&resolved, value, |c, v| c < v),
            FieldTest::Lte { value } => compare_number(&resolved, value, |c, v| c <= v),
            FieldTest::Range { min, max } => any_number(&resolved, &|n| n >= *min && n <= *max),
        }
    }

    fn eval_level(&self, test: &FieldTest) -> bool {
        let level = &self.target.log.level;
        let compare = |value: &CompareValue, f: fn(i32, i32) -> bool| match (value, level) {
            (_, LogLevel::UNKNOWN) => false,
            (CompareValue::Text(name), level) => {
                level_from_name(name).is_some_and(|v| f(level_priority(level), level_priority(&v)))
            }
            (CompareValue::Number(_), _) => false,
        };
        match test {
            FieldTest::Eq { value, .. } => level_name(level) == value.as_str(),
            FieldTest::Exists => true,
            FieldTest::Gt { value } => compare(value, |c, v| c > v),
            FieldTest::Gte { value } => compare(value, |c, v| c >= v),
            FieldTest::Lt { value } => compare(value, |c, v| c < v),
            FieldTest::Lte { value } => compare(value, |c, v| c <= v),
            // El valor de nivel ("WARN") nunca es numérico
            FieldTest::Range { .. } => false,
        }
    }
}

fn level_name(level: &LogLevel) -> &'static str {
    match level {
        LogLevel::TRACE => "TRACE",
        LogLevel::DEBUG => "DEBUG",
        LogLevel::INFO => "INFO",
        LogLevel::WARN => "WARN",
        LogLevel::ERROR => "ERROR",
        LogLevel::FATAL => "FATAL",
        LogLevel::UNKNOWN => "UNKNOWN",
    }
}

fn level_from_name(name: &str) -> Option<LogLevel> {
    match name {
        "TRACE" => Some(LogLevel::TRACE),
        "DEBUG" => Some(LogLevel::DEBUG),
        "INFO" => Some(LogLevel::INFO),
        "WARN" => Some(LogLevel::WARN),
        "ERROR" => Some(LogLevel::ERROR),
        "FATAL" => Some(LogLevel::FATAL),
        "UNKNOWN" => Some(LogLevel::UNKNOWN),
        _ => None,
    }
}

/// `[message, error, stackTrace, service, traceId, spanId, caller, podName, container, namespace]`
/// sin vacíos, unidos con `\n`, más `\n` y el `JSON.stringify` de `extra`.
pub fn search_text(target: &QueryTarget<'_>) -> String {
    let log = target.log;
    let parts = [
        Some(log.message.as_str()),
        log.error.as_deref(),
        log.stack_trace.as_deref(),
        log.service.as_deref(),
        log.trace_id.as_deref(),
        log.span_id.as_deref(),
        log.caller.as_deref(),
        log.pod_name.as_deref(),
        target.container,
        target.namespace,
    ];
    let mut text = String::new();
    for part in parts.into_iter().flatten().filter(|p| !p.is_empty()) {
        text.push_str(part);
        text.push('\n');
    }
    // Con partes presentes el join no lleva `\n` final y luego se añade uno: equivale a
    // terminar cada parte con `\n`. Sin partes, queda solo el `\n` separador.
    if text.is_empty() {
        text.push('\n');
    }
    write_js_object(&log.extra, &mut text);
    text
}

/// Clave plana `extra["a.b"]` si existe y no es null; si no, recorrido anidado `extra.a.b`.
fn resolve_attr<'a>(extra: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    if let Some(value) = extra.get(path).filter(|v| !v.is_null()) {
        return Some(value);
    }
    if !path.contains('.') {
        return None;
    }
    let mut parts = path.split('.');
    let mut current = parts.next().and_then(|first| extra.get(first));
    for part in parts {
        current = current
            .and_then(Value::as_object)
            .and_then(|nested| nested.get(part));
    }
    current.filter(|v| !v.is_null())
}

/// Forma textual de un valor JSON como en JS: `String()` para escalares y `JSON.stringify`
/// para objetos/arrays anidados.
fn string_form(value: &Value) -> Cow<'_, str> {
    match value {
        Value::String(s) => Cow::Borrowed(s),
        Value::Null => Cow::Borrowed("null"),
        Value::Bool(true) => Cow::Borrowed("true"),
        Value::Bool(false) => Cow::Borrowed("false"),
        Value::Number(n) => Cow::Owned(js_number(n)),
        Value::Array(_) | Value::Object(_) => {
            let mut out = String::new();
            write_js_json(value, &mut out);
            Cow::Owned(out)
        }
    }
}

/// Un array coincide si coincide cualquiera de sus elementos.
fn any_string(resolved: &Resolved<'_>, pred: &dyn Fn(&str) -> bool) -> bool {
    match resolved {
        Resolved::Str(s) => pred(s),
        // Los null dentro de un array no aportan texto (como `scalarString` en TS)
        Resolved::Json(Value::Array(items)) => items
            .iter()
            .filter(|item| !item.is_null())
            .any(|item| pred(&string_form(item))),
        Resolved::Json(value) => pred(&string_form(value)),
    }
}

/// `^-?\d+(\.\d+)?$` (dígitos ASCII, igual que `\d` de JS)
fn parse_decimal(text: &str) -> Option<f64> {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (int_part, frac_part) = match unsigned.split_once('.') {
        Some((int_part, frac_part)) => (int_part, Some(frac_part)),
        None => (unsigned, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(int_part) || frac_part.is_some_and(|f| !digits(f)) {
        return None;
    }
    text.parse::<f64>().ok()
}

fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => parse_decimal(s),
        _ => None,
    }
}

fn any_number(resolved: &Resolved<'_>, pred: &dyn Fn(f64) -> bool) -> bool {
    match resolved {
        Resolved::Str(s) => parse_decimal(s).is_some_and(pred),
        Resolved::Json(Value::Array(items)) => {
            items.iter().filter_map(number_of).any(pred)
        }
        Resolved::Json(value) => number_of(value).is_some_and(pred),
    }
}

fn compare_number(
    resolved: &Resolved<'_>,
    value: &CompareValue,
    cmp: impl Fn(f64, f64) -> bool,
) -> bool {
    match value {
        CompareValue::Number(expected) => any_number(resolved, &|n| cmp(n, *expected)),
        // Un nombre de nivel solo tiene sentido para `level`
        CompareValue::Text(_) => false,
    }
}

/// Glob insensible a mayúsculas (ambos textos ya en minúsculas): `*` = cualquier tramo de
/// caracteres. `anchored` exige coincidir con todo `text`; si no, basta una aparición.
fn glob_match(text: &str, pattern: &str, anchored: bool) -> bool {
    let segments: Vec<&str> = pattern.split('*').collect();

    // Busca los tramos en orden dentro de `window`, consumiéndola
    let find_all = |mut window: &str, segs: &[&str]| {
        segs.iter().all(|seg| match window.find(seg) {
            Some(i) => {
                window = &window[i + seg.len()..];
                true
            }
            None => false,
        })
    };

    if !anchored {
        return find_all(text, &segments);
    }
    let [first, middle @ .., last] = segments.as_slice() else {
        // Sin `*` el patrón es un único tramo: igualdad exacta
        return text == pattern;
    };
    text.strip_prefix(*first)
        .and_then(|rest| rest.strip_suffix(*last))
        .is_some_and(|window| find_all(window, middle))
}

// ---------------------------------------------------------------------------
// Serialización idéntica a JS (`JSON.stringify` y `String(number)`)
// ---------------------------------------------------------------------------

/// `String(n)` de JS para un número JSON (los enteros fuera de ±2^53 pasan por f64 como al
/// parsear con `JSON.parse`).
fn js_number(n: &serde_json::Number) -> String {
    const SAFE: i64 = 1 << 53;
    if let Some(i) = n.as_i64().filter(|i| (-SAFE..=SAFE).contains(i)) {
        return i.to_string();
    }
    if let Some(u) = n.as_u64().filter(|u| *u <= SAFE as u64) {
        return u.to_string();
    }
    match n.as_f64() {
        Some(f) => js_f64(f),
        None => n.to_string(),
    }
}

/// `Number.prototype.toString` (algoritmo de ECMA-262 sobre los dígitos más cortos que
/// ida y vuelta). Los valores no finitos no existen en JSON; se devuelven como `null`.
fn js_f64(f: f64) -> String {
    if !f.is_finite() {
        return "null".into();
    }
    if f == 0.0 {
        return "0".into();
    }
    let sci = format!("{:e}", f.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1;

    let mut out = String::new();
    if f < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        let e = n - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&e.abs().to_string());
    }
    out
}

fn write_js_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Los objetos de JS ordenan primero las claves que son índices de array (enteros canónicos
/// < 2^32 - 1, ascendentes) y después el resto en orden de inserción.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    key.parse::<u32>().ok().filter(|i| *i != u32::MAX)
}

fn write_js_object(map: &Map<String, Value>, out: &mut String) {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut named: Vec<(&String, &Value)> = Vec::new();
    for (key, value) in map {
        match array_index(key) {
            Some(i) => indexed.push((i, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(i, _, _)| *i);

    out.push('{');
    let entries = indexed
        .into_iter()
        .map(|(_, k, v)| (k, v))
        .chain(named);
    for (n, (key, value)) in entries.enumerate() {
        if n > 0 {
            out.push(',');
        }
        write_js_string(key, out);
        out.push(':');
        write_js_json(value, out);
    }
    out.push('}');
}

fn write_js_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&js_number(n)),
        Value::String(s) => write_js_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_js_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => write_js_object(map, out),
    }
}
