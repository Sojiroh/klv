//! Paridad TS ↔ Rust: los fixtures de `packages/core/test/parity/` los consume también la suite vitest
//! de `@klv/core`, que comprueba que `parseLogLine`, `parseQuery`, `matchesQuery` y `matchesFilter` los
//! cumplen. Aquí se comprueba lo mismo con el parser y el evaluador de Rust.

use serde::Deserialize;
use serde_json::Value;

use crate::parser::log_filter::{matches_filter, LogFilter};
use crate::parser::log_parser::{parse_log_line, LogLevel};
use crate::query::{matches_query, QueryNode, QueryTarget};

const PARSER_CASES: &str = include_str!("../../../../core/test/parity/parser.json");
const QUERY_CASES: &str = include_str!("../../../../core/test/parity/query.json");
const FILTER_CASES: &str = include_str!("../../../../core/test/parity/filter.json");

/// Igualdad canónica: los números se comparan por valor (`1.0` de serde == `1` de `JSON.stringify`)
/// y las claves de los objetos sin importar el orden.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

#[derive(Deserialize)]
struct ParserCase {
    name: String,
    line: String,
    pod: Option<String>,
    expected: Value,
}

#[test]
fn parser_matches_fixtures() {
    let cases: Vec<ParserCase> = serde_json::from_str(PARSER_CASES).expect("parser.json válido");
    assert!(!cases.is_empty());
    for case in cases {
        let actual = serde_json::to_value(parse_log_line(&case.line, case.pod.as_deref())).unwrap();
        assert!(
            same(&actual, &case.expected),
            "{}\n  actual:   {actual}\n  esperado: {}",
            case.name,
            case.expected
        );
    }
}

#[derive(Deserialize, Default)]
struct Context {
    pod: Option<String>,
    namespace: Option<String>,
    container: Option<String>,
}

#[derive(Deserialize)]
struct QueryCase {
    name: String,
    query: String,
    ast: QueryNode,
    line: String,
    #[serde(default)]
    context: Context,
    matches: bool,
}

#[test]
fn query_matches_fixtures() {
    let cases: Vec<QueryCase> = serde_json::from_str(QUERY_CASES).expect("query.json válido");
    assert!(!cases.is_empty());
    for case in cases {
        let log = parse_log_line(&case.line, case.context.pod.as_deref());
        let target = QueryTarget {
            log: &log,
            namespace: case.context.namespace.as_deref(),
            container: case.context.container.as_deref(),
        };
        assert_eq!(
            matches_query(&target, Some(&case.ast)),
            case.matches,
            "{}: {}",
            case.name,
            case.query
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilterSpec {
    level: Option<LogLevel>,
    min_level: Option<LogLevel>,
    search: Option<String>,
    trace_id: Option<String>,
    service: Option<String>,
    exclude_patterns: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct FilterCase {
    name: String,
    line: String,
    filter: FilterSpec,
    matches: bool,
}

#[test]
fn filter_matches_fixtures() {
    let cases: Vec<FilterCase> = serde_json::from_str(FILTER_CASES).expect("filter.json válido");
    assert!(!cases.is_empty());
    for case in cases {
        let spec = case.filter;
        let filter = LogFilter {
            level: spec.level,
            min_level: spec.min_level,
            search: spec.search,
            trace_id: spec.trace_id,
            service: spec.service,
            exclude_patterns: spec.exclude_patterns,
        };
        let log = parse_log_line(&case.line, None);
        assert_eq!(matches_filter(&log, &filter), case.matches, "{}", case.name);
    }
}
